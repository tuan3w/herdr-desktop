;; replace
; Markdown, block grammar. Inline content (emphasis, links, code spans) comes from markdown_inline.scm;
; fenced code content is injected by the highlighter, so it is cleared here, not coloured.

; headings
(atx_heading (_) @markup.heading)
(setext_heading (paragraph) @markup.heading)
(setext_heading [(setext_h1_underline) (setext_h2_underline)] @markup.heading)

; lists, quotes, rules
[
  (list_marker_plus)
  (list_marker_minus)
  (list_marker_star)
  (list_marker_dot)
  (list_marker_parenthesis)
] @markup.list
[(block_quote_marker) (block_continuation)] @markup.quote
(thematic_break) @markup
[(task_list_marker_checked) (task_list_marker_unchecked)] @markup.list

; fenced code: delimiters are markup, the info string a label, the body belongs to the injection
(fenced_code_block_delimiter) @markup.raw.delimiter
(info_string) @label
(code_fence_content) @none

; tables
(pipe_table_header "|" @punctuation.delimiter)
(pipe_table_row "|" @punctuation.delimiter)
(pipe_table_delimiter_row "|" @markup)
(pipe_table_delimiter_cell) @markup

; link reference definitions and footnotes
(link_reference_definition (link_label) @markup.link.label)
(link_reference_definition (link_destination) @markup.link.url)
(link_reference_definition (link_title) @string)

(backslash_escape) @string.escape
