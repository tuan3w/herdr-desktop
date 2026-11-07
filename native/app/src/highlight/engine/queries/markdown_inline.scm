;; replace
; Markdown, inline grammar: delimiters are quiet markup, the text between them carries the style.

; emphasis
(emphasis) @markup.italic
(strong_emphasis) @markup.strong
(strikethrough) @markup.strikethrough
(emphasis_delimiter) @markup

; code (math spans are left plain: `$5 and $10` reads as math to the grammar)
(code_span) @markup.raw.inline
(code_span_delimiter) @markup.raw.delimiter

; links: [text](url "title"), [text][label], [text][], [text], ![alt](src), <https://..>
(link_text) @markup.link.text
(image_description) @markup.link.text
(link_label) @markup.link.label
(link_destination) @markup.link.url
(link_title) @string
[(uri_autolink) (email_autolink)] @markup.link.url
(inline_link ["[" "]" "(" ")"] @punctuation.bracket)
(image ["!" "[" "]" "(" ")"] @punctuation.bracket)
(shortcut_link ["[" "]"] @punctuation.bracket)
(full_reference_link ["[" "]"] @punctuation.bracket)
(collapsed_reference_link ["[" "]"] @punctuation.bracket)

; escapes, entities, line breaks
[(backslash_escape) (hard_line_break) (entity_reference) (numeric_character_reference)] @string.escape

; inline html
(html_tag) @tag
