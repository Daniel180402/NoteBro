import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'

/** Renders model output as HTML. Sanitised because the text is generated. */
export function Markdown({ source }: { source: string }): React.JSX.Element {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true, breaks: true })),
    [source]
  )
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
