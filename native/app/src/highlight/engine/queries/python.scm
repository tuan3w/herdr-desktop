;; replace
;; Python. Later patterns beat earlier ones on the same node; inner nodes beat outer ones.

; ---- names: the generic rule first, then naming conventions, then context ------------------------

(identifier) @variable

; CamelCase names are classes (and type variables, exceptions); ALL_CAPS names are constants.
((identifier) @type
  (#match? @type "^_*[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$"))
((identifier) @constant
  (#match? @constant "^_*[A-Z][A-Z0-9_]+$"))
((identifier) @constant.builtin
  (#match? @constant.builtin "^__[a-z]+__$"))
((identifier) @constant.builtin
  (#any-of? @constant.builtin "Ellipsis" "NotImplemented"))

; Builtin classes and exceptions.
((identifier) @type.builtin
  (#any-of? @type.builtin
    "int" "float" "str" "bool" "bytes" "bytearray" "complex" "list" "dict" "set" "frozenset" "tuple"
    "object" "memoryview" "slice" "classmethod" "staticmethod" "property"
    "BaseException" "Exception" "ArithmeticError" "AssertionError" "AttributeError" "BufferError"
    "EOFError" "FloatingPointError" "GeneratorExit" "ImportError" "ModuleNotFoundError" "IndexError"
    "KeyError" "KeyboardInterrupt" "LookupError" "MemoryError" "NameError" "NotImplementedError"
    "OSError" "IOError" "FileNotFoundError" "FileExistsError" "PermissionError" "TimeoutError"
    "OverflowError" "RecursionError" "ReferenceError" "RuntimeError" "StopIteration"
    "StopAsyncIteration" "SyntaxError" "SystemError" "SystemExit" "TypeError" "UnboundLocalError"
    "UnicodeError" "UnicodeDecodeError" "UnicodeEncodeError" "ValueError" "ZeroDivisionError"
    "Warning" "UserWarning" "DeprecationWarning" "RuntimeWarning" "ExceptionGroup"))

; ---- literals ------------------------------------------------------------------------------------

[(integer) (float)] @number
[(true) (false) (none) (ellipsis)] @constant
(comment) @comment

(string) @string
(escape_sequence) @string.escape

; f-strings: the braces, the conversion and the format spec; the expression inside is code.
(interpolation) @none
(interpolation (format_specifier) @string)

; A string statement first in a module, class or function is its docstring.
(module . (comment)* . (expression_statement (string) @comment.documentation))
(class_definition body: (block . (comment)* . (expression_statement (string) @comment.documentation)))
(function_definition body: (block . (comment)* . (expression_statement (string) @comment.documentation)))

; The pattern of `re.compile(...)` and friends.
(call
  function: (attribute object: (identifier) @_module attribute: (identifier) @_fn)
  arguments: (argument_list . (string) @string.regexp)
  (#eq? @_module "re")
  (#any-of? @_fn "compile" "match" "search" "sub" "subn" "split" "findall" "finditer" "fullmatch"))

; ---- keywords ------------------------------------------------------------------------------------

["def" "class" "lambda" "import" "from" "as" "global" "nonlocal" "del" "pass" "print" "exec" "type"] @keyword
[(future_import_statement "__future__" @namespace)]
[(type_alias_statement "type" @keyword)]
["and" "or" "not" "in" "is" "is not" "not in"] @keyword
["if" "elif" "else" "for" "while" "break" "continue" "return" "try" "except" "finally"
 "raise" "assert" "with" "yield" "await" "async" "match" "case"] @keyword.control
; `in` of a for loop or comprehension belongs to the loop.
(for_statement "in" @keyword.control)
(for_in_clause "in" @keyword.control)
; The `else` / `if` of a comprehension and `from` of `yield from` and `raise ... from`.
(raise_statement "from" @keyword.control)
(yield "from" @keyword.control)

; ---- operators and punctuation -------------------------------------------------------------------

(binary_operator operator: _ @operator)
(unary_operator operator: _ @operator)
(augmented_assignment operator: _ @operator)
["=" ":=" "->" "~" "**" "*" "<>" "!=" "==" "<" ">" "<=" ">=" "%" "//" "/" "+" "-" "|" "&" "^" "<<" ">>"] @operator
(wildcard_import) @operator
(keyword_separator) @operator
(positional_separator) @operator

["(" ")" "[" "]" "{" "}"] @punctuation.bracket
["," ":" ";" "."] @punctuation.delimiter
(import_prefix) @punctuation.delimiter

; f-string braces beat the generic brackets.
(interpolation ["{" "}"] @string.interpolation)
(interpolation (type_conversion) @string.interpolation)
(format_expression ["{" "}"] @string.interpolation)

; ---- definitions and calls -----------------------------------------------------------------------

(function_definition name: (identifier) @function.def)
(class_definition name: (identifier) @type)
(class_definition superclasses: (argument_list (identifier) @type))
(class_definition superclasses: (argument_list (attribute attribute: (identifier) @type)))
(type_alias_statement left: (type (identifier) @type))

(call function: (identifier) @function.call)
(call function: (attribute attribute: (identifier) @function.method.call))
; A class instantiated or a builtin type converted: `Entry(...)`, `str(x)` are types, not calls.
(call function: (identifier) @type
  (#match? @type "^_*[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$"))
(call function: (identifier) @type.builtin
  (#any-of? @type.builtin "int" "float" "str" "bool" "bytes" "bytearray" "complex" "list" "dict" "set" "frozenset" "tuple" "object" "slice"))
(call function: (attribute attribute: (identifier) @type
  (#match? @type "^_*[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$")))
(call function: (identifier) @type.builtin
  (#any-of? @type.builtin "BaseException" "Exception" "ArithmeticError" "AssertionError" "AttributeError" "EOFError" "ImportError" "IndexError" "KeyError" "LookupError" "NameError" "NotImplementedError" "OSError" "IOError" "FileNotFoundError" "PermissionError" "TimeoutError" "OverflowError" "RuntimeError" "StopIteration" "SyntaxError" "SystemExit" "TypeError" "ValueError" "ZeroDivisionError" "Warning" "UserWarning" "DeprecationWarning" "RuntimeWarning" "ExceptionGroup"))
(call function: (identifier) @function.call
  (#match? @function.call "^__[a-z]+__$"))

; ---- attributes, parameters, self ----------------------------------------------------------------

; Parameters of a signature; the generic `self` rule comes after them.
(parameters (identifier) @variable.parameter)
(lambda_parameters (identifier) @variable.parameter)
(typed_parameter (identifier) @variable.parameter)
(default_parameter name: (identifier) @variable.parameter)
(typed_default_parameter name: (identifier) @variable.parameter)
(parameters (list_splat_pattern "*" @variable.parameter (identifier) @variable.parameter))
(parameters (dictionary_splat_pattern "**" @variable.parameter (identifier) @variable.parameter))
(lambda_parameters (list_splat_pattern "*" @variable.parameter (identifier) @variable.parameter))
(lambda_parameters (dictionary_splat_pattern "**" @variable.parameter (identifier) @variable.parameter))
(typed_parameter (list_splat_pattern "*" @variable.parameter (identifier) @variable.parameter))
(typed_parameter (dictionary_splat_pattern "**" @variable.parameter (identifier) @variable.parameter))
(keyword_argument name: (identifier) @variable.parameter)
(keyword_pattern (identifier) @variable.parameter)

((identifier) @variable.builtin
  (#any-of? @variable.builtin "self" "cls" "mcs" "metacls"))

(attribute attribute: (identifier) @property)
(attribute attribute: (identifier) @type
  (#match? @type "^_*[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$"))
(attribute attribute: (identifier) @constant
  (#match? @constant "^_*[A-Z][A-Z0-9_]+$"))
(call function: (attribute attribute: (identifier) @function.method.call))
(call function: (attribute attribute: (identifier) @type
  (#match? @type "^_*[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$")))

; ---- annotations ---------------------------------------------------------------------------------

(type (identifier) @type)
(type (attribute attribute: (identifier) @type))
(type (attribute object: (identifier) @namespace))
(type (subscript value: (identifier) @type))
(type (subscript value: (attribute attribute: (identifier) @type)))
(generic_type (identifier) @type)
(member_type (identifier) @type)
(splat_type (identifier) @type)
(type_parameter (type (identifier) @type))
((type (identifier) @type.builtin)
  (#any-of? @type.builtin "int" "float" "str" "bool" "bytes" "bytearray" "complex" "list" "dict" "set" "frozenset" "tuple" "object" "type" "slice"))
((generic_type (identifier) @type.builtin)
  (#any-of? @type.builtin "list" "dict" "set" "frozenset" "tuple" "type"))
(subscript value: (identifier) @_generic subscript: (identifier) @type
  (#any-of? @_generic "Generic" "Protocol"))
(subscript value: (identifier) @type.builtin
  (#any-of? @type.builtin "list" "dict" "set" "frozenset" "tuple" "type"))

; ---- imports -------------------------------------------------------------------------------------

(import_statement name: (dotted_name (identifier) @namespace))
(import_statement name: (aliased_import name: (dotted_name (identifier) @namespace) alias: (identifier) @namespace))
(import_from_statement module_name: (dotted_name (identifier) @namespace))
(import_from_statement module_name: (relative_import (dotted_name (identifier) @namespace)))

; ---- decorators: the whole line, `@` to the closing parenthesis ----------------------------------

(decorator) @attribute
(decorator (identifier) @attribute)
(decorator (attribute attribute: (identifier) @attribute))
(decorator (attribute object: (identifier) @attribute))
(decorator (attribute object: (attribute attribute: (identifier) @attribute)))
(decorator (attribute object: (attribute object: (identifier) @attribute)))
(decorator (attribute "." @attribute))
(decorator (attribute object: (attribute "." @attribute)))
(decorator (call function: (identifier) @attribute))
(decorator (call function: (attribute attribute: (identifier) @attribute)))
(decorator (call function: (attribute object: (identifier) @attribute)))
(decorator (call function: (attribute object: (attribute attribute: (identifier) @attribute))))
(decorator (call function: (attribute object: (attribute object: (identifier) @attribute))))
(decorator (call function: (attribute "." @attribute)))
(decorator (call function: (attribute object: (attribute "." @attribute))))
(decorator (call arguments: (argument_list ["(" ")" ","] @attribute)))
(decorator (call arguments: (argument_list (identifier) @attribute)))
(decorator (call arguments: (argument_list (string) @attribute)))
(decorator (call arguments: (argument_list [(integer) (float) (true) (false) (none)] @attribute)))
(decorator (call arguments: (argument_list (keyword_argument name: (identifier) @attribute "=" @attribute))))
(decorator (call arguments: (argument_list (keyword_argument value: (identifier) @attribute))))
(decorator (call arguments: (argument_list (keyword_argument value: (string) @attribute))))
(decorator (call arguments: (argument_list (keyword_argument value: [(integer) (float) (true) (false) (none)] @attribute))))
(decorator (call arguments: (argument_list [(list ["[" "]" ","] @attribute) (tuple ["(" ")" ","] @attribute)])))
(decorator (call arguments: (argument_list [(list [(string) (identifier) (integer) (true) (false) (none)] @attribute) (tuple [(string) (identifier) (integer) (true) (false) (none)] @attribute)])))
(decorator (call arguments: (argument_list (keyword_argument value: [(list ["[" "]" ","] @attribute) (tuple ["(" ")" ","] @attribute)]))))
(decorator (call arguments: (argument_list (keyword_argument value: [(list [(string) (identifier) (integer) (true) (false) (none)] @attribute) (tuple [(string) (identifier) (integer) (true) (false) (none)] @attribute)]))))
