;; replace
; HTML: tags, attributes, values; script/style bodies (raw_text) are injected elsewhere.
(comment) @comment
(tag_name) @tag
(erroneous_end_tag_name) @tag
(attribute_name) @tag.attribute
(attribute_value) @string
(quoted_attribute_value) @string
(entity) @string.escape

; <!doctype html>
"doctype" @keyword.directive
(doctype) @keyword.directive

["<" ">" "</" "/>" "<!"] @punctuation.bracket
"=" @punctuation.delimiter
