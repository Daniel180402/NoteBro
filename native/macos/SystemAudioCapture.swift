//
//  SystemAudioCapture.swift
//  NoteBro — macOS system-audio capture helper.
//
//  Captures everything the machine is playing (the other side of a call) via
//  ScreenCaptureKit, so no virtual audio driver such as BlackHole is needed.
//  ScreenCaptureKit refuses an audio-only stream, so we ask for the smallest
//  video surface it accepts (2x2 @ 1fps) and throw every frame away.
//
//  stdout : raw 16-bit little-endian mono PCM @ 16 kHz (nothing else)
//  stderr : one status line per event — "READY", "ERROR <message>"
//
//  Exits when stdin reaches EOF, so it can never outlive the Electron app.
//
//  Usage: notebro-sysaudio [--exclude-bundle <bundle-id>]
//

import AVFoundation
import CoreMedia
import Darwin
import Foundation
import ScreenCaptureKit

private let targetSampleRate = 16_000

private func status(_ line: String) {
    if let data = (line + "\n").data(using: .utf8) {
        data.withUnsafeBytes { _ = write(2, $0.baseAddress!, $0.count) }
    }
}

/// Writes to stdout, retrying short writes. A closed pipe means the parent is
/// gone, which is a normal shutdown, not a failure.
private func emit(_ bytes: UnsafeRawPointer, _ count: Int) {
    var written = 0
    while written < count {
        let n = write(1, bytes.advanced(by: written), count - written)
        if n <= 0 {
            if errno == EINTR { continue }
            exit(0)
        }
        written += n
    }
}

final class AudioTap: NSObject, SCStreamOutput, SCStreamDelegate {
    private var warnedInterleaved = false
    private var audioBuffers = 0
    private var screenBuffers = 0
    private var describedFormat = false

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        status("ERROR stream stopped: \(error.localizedDescription)")
        exit(3)
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        if outputType == .screen {
            screenBuffers += 1
            if screenBuffers == 1 { status("INFO primo fotogramma ricevuto") }
            return
        }
        guard outputType == .audio, CMSampleBufferDataIsReady(sampleBuffer) else { return }

        audioBuffers += 1
        if audioBuffers == 1 || audioBuffers == 100 {
            status("INFO buffer audio ricevuti: \(audioBuffers)")
        }

        guard
            let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
            let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)?.pointee
        else {
            status("ERROR descrizione di formato assente sul buffer audio")
            return
        }

        if !describedFormat {
            describedFormat = true
            let interleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
            status(
                "INFO formato audio: \(Int(asbd.mSampleRate)) Hz, \(asbd.mChannelsPerFrame) canali, "
                    + "\(asbd.mBitsPerChannel) bit, interleaved=\(interleaved)"
            )
        }

        var listSize = 0
        guard
            CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                sampleBuffer,
                bufferListSizeNeededOut: &listSize,
                bufferListOut: nil,
                bufferListSize: 0,
                blockBufferAllocator: nil,
                blockBufferMemoryAllocator: nil,
                flags: 0,
                blockBufferOut: nil
            ) == noErr, listSize > 0
        else {
            status("ERROR dimensione della lista di buffer audio non ottenibile")
            return
        }

        let raw = UnsafeMutableRawPointer.allocate(byteCount: listSize, alignment: 16)
        defer { raw.deallocate() }

        var blockBuffer: CMBlockBuffer?
        guard
            CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                sampleBuffer,
                bufferListSizeNeededOut: nil,
                bufferListOut: raw.assumingMemoryBound(to: AudioBufferList.self),
                bufferListSize: listSize,
                blockBufferAllocator: nil,
                blockBufferMemoryAllocator: nil,
                flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                blockBufferOut: &blockBuffer
            ) == noErr
        else {
            status("ERROR estrazione della lista di buffer audio fallita")
            return
        }

        let buffers = UnsafeMutableAudioBufferListPointer(
            raw.assumingMemoryBound(to: AudioBufferList.self))
        guard let first = buffers.first, let firstData = first.mData else {
            status("ERROR lista di buffer audio vuota")
            return
        }

        let isInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
        let samples: [Int16]

        if isInterleaved {
            // One buffer holding all channels frame by frame.
            let stride = Int(asbd.mChannelsPerFrame)
            guard stride > 0 else { return }
            let total = Int(first.mDataByteSize) / MemoryLayout<Float32>.size
            let frames = total / stride
            guard frames > 0 else { return }
            if !warnedInterleaved {
                warnedInterleaved = true
                status("INFO interleaved input, \(stride) channel(s)")
            }
            let src = firstData.assumingMemoryBound(to: Float32.self)
            samples = (0..<frames).map { frame in
                var sum: Float32 = 0
                for channel in 0..<stride { sum += src[frame * stride + channel] }
                return Self.toPCM(sum / Float32(stride))
            }
        } else {
            // One buffer per channel; average them down to mono.
            let frames = Int(first.mDataByteSize) / MemoryLayout<Float32>.size
            guard frames > 0 else { return }
            let channels = buffers.count
            let src = firstData.assumingMemoryBound(to: Float32.self)
            samples = (0..<frames).map { frame in
                var sum = src[frame]
                if channels > 1 {
                    for channel in 1..<channels {
                        if let data = buffers[channel].mData {
                            sum += data.assumingMemoryBound(to: Float32.self)[frame]
                        }
                    }
                    sum /= Float32(channels)
                }
                return Self.toPCM(sum)
            }
        }

        samples.withUnsafeBytes { emit($0.baseAddress!, $0.count) }
    }

    private static func toPCM(_ value: Float32) -> Int16 {
        let clamped = max(-1, min(1, value))
        return Int16(clamped * 32_767)
    }
}

@main
struct SystemAudioCapture {
    static func main() {
        var excludeBundleID: String?
        var arguments = Array(CommandLine.arguments.dropFirst())
        while let flag = arguments.first {
            arguments.removeFirst()
            switch flag {
            case "--exclude-bundle":
                excludeBundleID = arguments.first
                if !arguments.isEmpty { arguments.removeFirst() }
            default:
                status("ERROR unknown argument: \(flag)")
                exit(64)
            }
        }

        installShutdownHooks()

        Task {
            do {
                try await start(excludeBundleID: excludeBundleID)
            } catch {
                status("ERROR \(error.localizedDescription)")
                exit(2)
            }
        }

        dispatchMain()
    }

    /// Stop on SIGINT/SIGTERM, and on stdin EOF so a crashed parent can't leave
    /// this process recording in the background.
    private static func installShutdownHooks() {
        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { exit(0) }
            source.resume()
            shutdownSources.append(source)
        }

        let stdinSource = DispatchSource.makeReadSource(fileDescriptor: 0, queue: .main)
        stdinSource.setEventHandler {
            var scratch = [UInt8](repeating: 0, count: 256)
            if read(0, &scratch, scratch.count) <= 0 { exit(0) }
        }
        stdinSource.resume()
        shutdownSources.append(stdinSource)
    }

    private static func start(excludeBundleID: String?) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false)

        guard let display = content.displays.first else {
            status("ERROR no display available for capture")
            exit(4)
        }

        // Keep our own playback out of the recording so nothing can feed back.
        let excluded = content.applications.filter { $0.bundleIdentifier == excludeBundleID }
        let filter = SCContentFilter(
            display: display, excludingApplications: excluded, exceptingWindows: [])

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.sampleRate = targetSampleRate
        config.channelCount = 1
        config.excludesCurrentProcessAudio = true
        // Smallest video surface ScreenCaptureKit will accept; frames are dropped.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 6
        config.showsCursor = false

        let tap = AudioTap()
        activeTap = tap
        let stream = SCStream(filter: filter, configuration: config, delegate: tap)
        try stream.addStreamOutput(
            tap, type: .audio, sampleHandlerQueue: DispatchQueue(label: "notebro.audio"))
        // ScreenCaptureKit will not start a stream with no screen consumer.
        try stream.addStreamOutput(
            tap, type: .screen, sampleHandlerQueue: DispatchQueue(label: "notebro.video"))

        try await stream.startCapture()
        activeStream = stream
        status("READY sampleRate=\(targetSampleRate) channels=1 format=s16le")
    }
}

private var shutdownSources: [any DispatchSourceProtocol] = []
private var activeStream: SCStream?
/// SCStream keeps its delegate and its outputs weakly, so the tap has to be
/// retained here. Without this it is deallocated as soon as start() returns and
/// the stream runs on, delivering its buffers to nobody: READY, then silence.
private var activeTap: AudioTap?
