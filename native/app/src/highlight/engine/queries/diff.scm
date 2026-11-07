;; replace
; Diff: the whole line is coloured by what it is; context stays plain.
(addition) @diff.plus
(deletion) @diff.minus
[(new_file) (old_file)] @diff.delta
(location) @diff.delta
(command) @diff.delta
(index) @diff.delta
(mode) @diff.delta
(similarity) @diff.delta
(binary_change) @diff.delta
(comment) @comment
(file_change) @diff.delta
["rename" "from" "to" "new" "file" "mode" "deleted" "old" "similarity" "index" "Binary" "files" "and" "differ"] @diff.delta
(filename) @diff.delta
; "\ No newline at end of file"
((context) @comment (#match? @comment "^\\\\"))
