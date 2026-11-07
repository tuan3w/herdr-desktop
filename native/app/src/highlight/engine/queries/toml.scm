;; replace
; TOML: table headers are namespaces, keys are properties.
(comment) @comment

; keys (dotted keys nest to the left: a.b.c = ((a.b).c))
[(bare_key) (quoted_key)] @property

; table headers: [a.b] and [[a.b]]; a dotted_key nests to the left, so spell the depths out
(table [(bare_key) (quoted_key)] @namespace)
(table (dotted_key [(bare_key) (quoted_key)] @namespace))
(table (dotted_key (dotted_key [(bare_key) (quoted_key)] @namespace)))
(table (dotted_key (dotted_key (dotted_key [(bare_key) (quoted_key)] @namespace))))
(table (dotted_key (dotted_key (dotted_key (dotted_key [(bare_key) (quoted_key)] @namespace)))))
(table (dotted_key (dotted_key (dotted_key (dotted_key (dotted_key [(bare_key) (quoted_key)] @namespace))))))
(table_array_element [(bare_key) (quoted_key)] @namespace)
(table_array_element (dotted_key [(bare_key) (quoted_key)] @namespace))
(table_array_element (dotted_key (dotted_key [(bare_key) (quoted_key)] @namespace)))
(table_array_element (dotted_key (dotted_key (dotted_key [(bare_key) (quoted_key)] @namespace))))
(table_array_element (dotted_key (dotted_key (dotted_key (dotted_key [(bare_key) (quoted_key)] @namespace)))))
(table_array_element (dotted_key (dotted_key (dotted_key (dotted_key (dotted_key [(bare_key) (quoted_key)] @namespace))))))
; a header still being typed
(ERROR "[" . [(bare_key) (quoted_key)] @namespace)
(ERROR "[[" . [(bare_key) (quoted_key)] @namespace)

; values
(string) @string
(escape_sequence) @string.escape
(boolean) @constant
[(integer) (float)] @number
[(offset_date_time) (local_date_time) (local_date) (local_time)] @number

; punctuation
["." "," "="] @punctuation.delimiter
["[" "]" "[[" "]]" "{" "}"] @punctuation.bracket
