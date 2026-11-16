let failures = 0

export function section(title) {
  console.log(`\n${title}`)
}

export function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

export function skip(name, why) {
  console.log(`  skip ${name} — ${why}`)
}

/** Returns the failures recorded since the last call and resets the counter. */
export function takeFailures() {
  const total = failures
  failures = 0
  return total
}
