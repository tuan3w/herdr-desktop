;; replace
; JSON / JSONC: keys are properties, values keep their literal kind.
(string) @string
(pair key: (string) @property)
(number) @number
[(true) (false) (null)] @constant
; The grammar's escape node for \uXXXX covers only the `\u`; the four hex digits are left to the
; escape post-pass instead of being split off.
((escape_sequence) @string.escape (#not-eq? @string.escape "\\u"))
(comment) @comment
["{" "}" "[" "]"] @punctuation.bracket
["," ":"] @punctuation.delimiter
; a key whose value has not arrived yet (streaming) sits in an error recovery node
(_ (string) @property . ":")
; the grammar rejects `+` in an exponent (1e+5): keep the pieces looking like one number
((ERROR) @number (#match? @number "^[eE][+]$"))
(ERROR (string) @property . ":")
