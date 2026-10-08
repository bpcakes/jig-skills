use crate::model::{Coverage, Declaration, MemberContract};
use ra_ap_syntax::{AstNode, Edition, SourceFile, SyntaxKind, SyntaxNode, SyntaxToken, ast};
use serde_json::json;
use std::collections::BTreeMap;

fn child<N: AstNode>(node: &SyntaxNode) -> Option<N> {
    node.children().find_map(N::cast)
}

fn tokens(node: &SyntaxNode) -> Vec<SyntaxToken> {
    node.descendants_with_tokens()
        .filter_map(|element| element.into_token())
        .filter(|token| !token.kind().is_trivia())
        .collect()
}

pub fn canonical(node: &SyntaxNode) -> String {
    // Keep token boundaries and literal contents, including whitespace inside strings.
    tokens(node)
        .iter()
        .map(|token| token.text())
        .collect::<Vec<_>>()
        .join(" ")
}

fn node_name(node: &SyntaxNode) -> Option<String> {
    child::<ast::Name>(node).map(|name| {
        name.syntax()
            .text()
            .to_string()
            .trim_start_matches("r#")
            .into()
    })
}

fn visibility(node: &SyntaxNode) -> String {
    child::<ast::Visibility>(node)
        .map(|value| canonical(value.syntax()))
        .unwrap_or_else(|| "private".into())
}

fn attributes(node: &SyntaxNode) -> Vec<String> {
    node.children()
        .filter_map(ast::Attr::cast)
        .map(|attr| canonical(attr.syntax()))
        .collect()
}

fn offset_location(source: &str, offset: usize) -> (usize, usize) {
    let prefix = &source[..offset];
    let line = prefix.bytes().filter(|&b| b == b'\n').count() + 1;
    let column = prefix.rsplit('\n').next().unwrap_or("").chars().count() + 1;
    (line, column)
}

fn anchor(source: &str, node: &SyntaxNode) -> (usize, usize) {
    let token = node
        .children_with_tokens()
        .filter_map(|element| element.into_token())
        .find(|token| {
            matches!(
                token.text(),
                "struct" | "union" | "enum" | "trait" | "fn" | "type" | "impl" | "mod"
            )
        });
    offset_location(
        source,
        token
            .map(|t| usize::from(t.text_range().start()))
            .unwrap_or_else(|| usize::from(node.text_range().start())),
    )
}

// The cfg token-tree grammar is separate from Rust syntax. Unknown predicates remain
// possible; exclude only conditions that are definitely false with `test = false`.
#[derive(Clone, Copy)]
enum Truth {
    Yes,
    No,
    Unknown,
}

fn cfg_value(parts: &[String], cursor: &mut usize) -> Truth {
    let Some(name) = parts.get(*cursor) else {
        return Truth::Unknown;
    };
    *cursor += 1;
    if parts.get(*cursor).map(String::as_str) == Some("(") {
        *cursor += 1;
        let mut values = Vec::new();
        while *cursor < parts.len() && parts[*cursor] != ")" {
            let before = *cursor;
            values.push(cfg_value(parts, cursor));
            if *cursor == before {
                return Truth::Unknown;
            }
            if parts.get(*cursor).map(String::as_str) == Some(",") {
                *cursor += 1;
            } else if parts.get(*cursor).map(String::as_str) != Some(")") {
                return Truth::Unknown;
            }
        }
        if parts.get(*cursor).map(String::as_str) != Some(")") {
            return Truth::Unknown;
        }
        *cursor += 1;
        match name.as_str() {
            "all" if values.iter().any(|v| matches!(v, Truth::No)) => Truth::No,
            "all" if values.iter().all(|v| matches!(v, Truth::Yes)) => Truth::Yes,
            "any" if values.iter().any(|v| matches!(v, Truth::Yes)) => Truth::Yes,
            "any" if values.iter().all(|v| matches!(v, Truth::No)) => Truth::No,
            "not" if values.len() == 1 => match values[0] {
                Truth::Yes => Truth::No,
                Truth::No => Truth::Yes,
                Truth::Unknown => Truth::Unknown,
            },
            _ => Truth::Unknown,
        }
    } else if parts.get(*cursor).map(String::as_str) == Some("=") {
        *cursor += 1;
        if *cursor < parts.len() {
            *cursor += 1;
        }
        Truth::Unknown
    } else if name == "test" {
        Truth::No
    } else {
        Truth::Unknown
    }
}

pub fn directly_test_only(node: &SyntaxNode) -> bool {
    node.children().filter_map(ast::Attr::cast).any(|attr| {
        let parts: Vec<String> = tokens(attr.syntax())
            .iter()
            .map(|t| t.text().to_string())
            .collect();
        let Some(start) = parts.iter().position(|t| t == "[").map(|i| i + 1) else {
            return false;
        };
        let tail = &parts[start..];
        // Function-level #[test], #[bench], and namespaced async test attributes.
        if tail
            .iter()
            .take_while(|t| t.as_str() != "(" && t.as_str() != "]")
            .last()
            .is_some_and(|name| name == "test" || name == "bench")
        {
            return true;
        }
        if tail.first().map(String::as_str) != Some("cfg")
            || tail.get(1).map(String::as_str) != Some("(")
        {
            return false;
        }
        let mut cursor = 2;
        let value = cfg_value(tail, &mut cursor);
        matches!(value, Truth::No) && tail.get(cursor).map(String::as_str) == Some(")")
    })
}

pub fn test_only(node: &SyntaxNode) -> bool {
    node.ancestors()
        .any(|ancestor| directly_test_only(&ancestor))
}

fn header(node: &SyntaxNode) -> String {
    let name_range = child::<ast::Name>(node).map(|name| name.syntax().text_range());
    let omitted: Vec<_> = node
        .children()
        .filter(|child| {
            matches!(
                child.kind(),
                SyntaxKind::ATTR
                    | SyntaxKind::RECORD_FIELD_LIST
                    | SyntaxKind::TUPLE_FIELD_LIST
                    | SyntaxKind::VARIANT_LIST
                    | SyntaxKind::ASSOC_ITEM_LIST
                    | SyntaxKind::BLOCK_EXPR
            )
        })
        .map(|child| child.text_range())
        .collect();
    tokens(node)
        .into_iter()
        .filter(|token| {
            !omitted
                .iter()
                .any(|range| range.contains_range(token.text_range()))
        })
        .map(|token| {
            if name_range.is_some_and(|range| range.contains_range(token.text_range())) {
                "$name".into()
            } else {
                token.text().into()
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
}

fn field_contract(node: &SyntaxNode) -> MemberContract {
    MemberContract {
        visibility: visibility(node),
        attributes: attributes(node),
    }
}

fn fields(
    node: &SyntaxNode,
) -> (
    String,
    BTreeMap<String, String>,
    BTreeMap<String, MemberContract>,
) {
    let mut members = BTreeMap::new();
    let mut contracts = BTreeMap::new();
    if let Some(list) = child::<ast::RecordFieldList>(node) {
        for field in list.syntax().children().filter_map(ast::RecordField::cast) {
            if let (Some(name), Some(ty)) = (
                node_name(field.syntax()),
                child::<ast::Type>(field.syntax()),
            ) {
                members.insert(name.clone(), canonical(ty.syntax()));
                contracts.insert(name, field_contract(field.syntax()));
            }
        }
        ("record".into(), members, contracts)
    } else if let Some(list) = child::<ast::TupleFieldList>(node) {
        for (index, field) in list
            .syntax()
            .children()
            .filter_map(ast::TupleField::cast)
            .enumerate()
        {
            if let Some(ty) = child::<ast::Type>(field.syntax()) {
                members.insert(index.to_string(), canonical(ty.syntax()));
                contracts.insert(index.to_string(), field_contract(field.syntax()));
            }
        }
        ("tuple".into(), members, contracts)
    } else {
        ("unit".into(), members, contracts)
    }
}

fn signature(function: &ast::Fn) -> String {
    let node = function.syntax();
    let name = child::<ast::Name>(node).map(|n| n.syntax().text_range());
    let body = function.body().map(|b| b.syntax().text_range());
    let patterns: Vec<_> = function
        .param_list()
        .into_iter()
        .flat_map(|p| p.syntax().children().collect::<Vec<_>>())
        .filter_map(ast::Param::cast)
        .filter_map(|p| child::<ast::Pat>(p.syntax()))
        .map(|p| p.syntax().text_range())
        .collect();
    let attrs: Vec<_> = node
        .children()
        .filter_map(ast::Attr::cast)
        .map(|a| a.syntax().text_range())
        .collect();
    let mut output = Vec::new();
    for token in tokens(node) {
        let range = token.text_range();
        if body.is_some_and(|body| body.contains_range(range))
            || attrs.iter().any(|a| a.contains_range(range))
        {
            continue;
        }
        if name.is_some_and(|name| name.contains_range(range)) {
            output.push("$name".into());
        } else if let Some(pattern) = patterns.iter().find(|p| p.contains_range(range)) {
            if range.start() == pattern.start() {
                output.push("_".into());
            }
        } else if !(token.text() == ";" && token.parent().as_ref() == Some(node)) {
            output.push(token.text().into());
        }
    }
    output.join(" ")
}

fn callable_body(body: &SyntaxNode, output: &mut Declaration) {
    let parts = tokens(body);
    for (index, token) in parts.iter().enumerate() {
        let text = token.text();
        let previous = index.checked_sub(1).map(|i| parts[i].text()).unwrap_or("");
        let next = parts.get(index + 1).map(|t| t.text()).unwrap_or("");
        let literal = matches!(
            token.kind(),
            SyntaxKind::INT_NUMBER
                | SyntaxKind::FLOAT_NUMBER
                | SyntaxKind::STRING
                | SyntaxKind::BYTE_STRING
                | SyntaxKind::CHAR
                | SyntaxKind::BYTE
                | SyntaxKind::C_STRING
        );
        let shaped = if literal {
            output.literals.push(text.into());
            "$literal".to_string()
        } else if token.kind() == SyntaxKind::IDENT {
            if matches!(next, "(" | "!") || matches!(previous, "." | "::") {
                output.calls.insert(if next == "!" {
                    format!("{text}!")
                } else {
                    text.into()
                });
            }
            if matches!(previous, "." | "::") || next == "!" {
                text.into()
            } else if text.chars().next().is_some_and(char::is_uppercase) {
                "$type".into()
            } else {
                "$id".into()
            }
        } else {
            text.into()
        };
        output.body_tokens.push(shaped);
    }
}

fn module_path(node: &SyntaxNode, base: &[String]) -> Vec<String> {
    let mut modules: Vec<_> = node
        .ancestors()
        .skip(1)
        .filter_map(ast::Module::cast)
        .filter_map(|m| node_name(m.syntax()))
        .collect();
    modules.reverse();
    base.iter().cloned().chain(modules).collect()
}

fn nominal_path(ty: &ast::Type) -> Option<Vec<String>> {
    let ast::Type::PathType(path_type) = ty else {
        return None;
    };
    let path = child::<ast::Path>(path_type.syntax())?;
    // Reject qualified <T as Trait>::Assoc targets; resolution needs semantics.
    if path
        .syntax()
        .descendants()
        .any(|n| n.kind() == SyntaxKind::TYPE_ANCHOR)
    {
        return None;
    }
    let mut segments = Vec::new();
    for token in tokens(path.syntax()) {
        if token
            .parent_ancestors()
            .take_while(|n| n != path.syntax())
            .any(|n| n.kind() == SyntaxKind::GENERIC_ARG_LIST)
        {
            continue;
        }
        if token.kind() == SyntaxKind::IDENT || matches!(token.text(), "crate" | "self" | "super") {
            segments.push(token.text().into());
        }
    }
    (!segments.is_empty()).then_some(segments)
}

pub fn parse_file(
    source: &str,
    file: &str,
    crate_root: &str,
    base_module: &[String],
    edition: Edition,
    include_tests: bool,
    coverage: &mut Coverage,
) -> Vec<Declaration> {
    let parsed = SourceFile::parse(source, edition);
    let errors = parsed.errors();
    if !errors.is_empty() {
        for error in errors {
            let (line, column) = offset_location(source, usize::from(error.range().start()));
            coverage.parse_errors.push(json!({"file": file, "line": line, "column": column, "error": error.to_string(), "action": "file excluded from candidates"}));
        }
        return Vec::new();
    }
    let root = parsed.tree();
    let mut result = Vec::new();
    for node in root.syntax().descendants() {
        if node
            .ancestors()
            .skip(1)
            .any(|a| matches!(a.kind(), SyntaxKind::FN | SyntaxKind::TOKEN_TREE))
        {
            continue;
        }
        if matches!(
            node.kind(),
            SyntaxKind::MACRO_CALL | SyntaxKind::MACRO_RULES | SyntaxKind::MACRO_DEF
        ) {
            let (line, column) = anchor(source, &node);
            coverage
                .unexpanded_macros
                .push(json!({"file": file, "line": line, "column": column}));
        }
        let kind = match node.kind() {
            SyntaxKind::STRUCT => "struct",
            SyntaxKind::UNION => "union",
            SyntaxKind::ENUM => "enum",
            SyntaxKind::TRAIT => "trait",
            SyntaxKind::TYPE_ALIAS => "type_alias",
            SyntaxKind::FN => "function",
            SyntaxKind::MODULE => "module",
            _ => continue,
        };
        let Some(name) = node_name(&node) else {
            continue;
        };
        let (line, column) = anchor(source, &node);
        if !include_tests && test_only(&node) {
            coverage.skipped_item_count += 1;
            if !node.ancestors().skip(1).any(|a| directly_test_only(&a)) {
                coverage.skipped_items.push(
                    json!({"file":file, "line":line, "name":name, "reason":"test_attribute"}),
                );
            }
            continue;
        }
        if kind == "module" {
            continue;
        }
        let parent = node.ancestors().skip(1).find(|a| {
            matches!(
                a.kind(),
                SyntaxKind::IMPL | SyntaxKind::TRAIT | SyntaxKind::MODULE | SyntaxKind::SOURCE_FILE
            )
        });
        if kind == "type_alias"
            && parent
                .as_ref()
                .is_some_and(|p| matches!(p.kind(), SyntaxKind::IMPL | SyntaxKind::TRAIT))
        {
            continue;
        }
        let mut item = Declaration {
            kind: kind.into(),
            name,
            file: file.into(),
            line,
            column,
            visibility: visibility(&node),
            attributes: attributes(&node),
            module: module_path(&node, base_module),
            crate_root: crate_root.into(),
            header: header(&node),
            ..Default::default()
        };
        // Enclosing cfg/impl attributes are part of the observed contract too.
        for ancestor in node.ancestors().skip(1) {
            item.attributes.extend(attributes(&ancestor));
        }
        match kind {
            "struct" | "union" => {
                (item.shape, item.members, item.member_contracts) = fields(&node);
            }
            "enum" => {
                if let Some(list) = child::<ast::VariantList>(&node) {
                    for variant in list.syntax().children().filter_map(ast::Variant::cast) {
                        let Some(name) = node_name(variant.syntax()) else {
                            continue;
                        };
                        let (shape, fields, contracts) = fields(variant.syntax());
                        let payload = if shape == "unit" {
                            shape
                        } else {
                            format!(
                                "{shape}{{{}}}",
                                fields
                                    .iter()
                                    .map(|(name, ty)| format!("{name}:{ty}"))
                                    .collect::<Vec<_>>()
                                    .join(",")
                            )
                        };
                        let discriminant = child::<ast::Expr>(variant.syntax())
                            .map(|expr| format!("={}", canonical(expr.syntax())))
                            .unwrap_or_default();
                        item.members.insert(name.clone(), payload + &discriminant);
                        item.member_contracts
                            .insert(name.clone(), field_contract(variant.syntax()));
                        for (field, contract) in contracts {
                            item.member_contracts
                                .insert(format!("{name}.{field}"), contract);
                        }
                    }
                }
            }
            "trait" => {
                if let Some(list) = child::<ast::AssocItemList>(&node) {
                    for member in list.syntax().children() {
                        if !include_tests && test_only(&member) {
                            continue;
                        }
                        let Some(name) = node_name(&member) else {
                            continue;
                        };
                        if let Some(function) = ast::Fn::cast(member.clone()) {
                            item.methods.insert(name.clone(), signature(&function));
                        } else if matches!(
                            member.kind(),
                            SyntaxKind::TYPE_ALIAS | SyntaxKind::CONST
                        ) {
                            item.members.insert(name.clone(), canonical(&member));
                        }
                        item.member_contracts.insert(name, field_contract(&member));
                    }
                }
            }
            "type_alias" => {
                if let Some(ty) = child::<ast::Type>(&node) {
                    item.members.insert("target".into(), canonical(ty.syntax()));
                }
            }
            "function" => {
                let function = ast::Fn::cast(node.clone()).expect("FN kind has Fn AST");
                item.signature = signature(&function);
                item.header = item.signature.clone();
                if let Some(parent) = parent {
                    if let Some(implementation) = ast::Impl::cast(parent.clone()) {
                        item.kind = "method".into();
                        let ty = implementation.self_ty();
                        item.owner = ty.as_ref().map(|ty| canonical(ty.syntax()));
                        item.impl_target = ty.as_ref().and_then(nominal_path);
                        item.impl_trait = implementation.trait_().map(|ty| canonical(ty.syntax()));
                        item.header = format!("{} | {}", item.header, header(&parent));
                        if let Some(owner) = &item.owner {
                            item.name = format!("{owner}::{}", item.name);
                        }
                    } else if parent.kind() == SyntaxKind::TRAIT {
                        item.kind = "method".into();
                        item.owner = node_name(&parent);
                        if let Some(owner) = &item.owner {
                            item.name = format!("{owner}::{}", item.name);
                        }
                    }
                }
                if let Some(body) = function.body() {
                    callable_body(body.syntax(), &mut item);
                }
            }
            _ => {}
        }
        result.push(item);
    }
    result
}

pub fn generated_file(source: &str, file_name: &str, edition: Edition) -> bool {
    let name = file_name.to_lowercase();
    if matches!(name.as_str(), "generated.rs" | "bindings.rs")
        || name.ends_with(".generated.rs")
        || name.ends_with("_generated.rs")
    {
        return true;
    }
    let parsed = SourceFile::parse(source, edition);
    for token in parsed
        .tree()
        .syntax()
        .descendants_with_tokens()
        .filter_map(|e| e.into_token())
    {
        if token.kind() == SyntaxKind::WHITESPACE {
            continue;
        }
        if token.kind() != SyntaxKind::COMMENT {
            break;
        }
        let text = token.text();
        if text.starts_with("///")
            || text.starts_with("//!")
            || text.starts_with("/**")
            || text.starts_with("/*!")
        {
            continue;
        }
        let contents = text
            .strip_prefix("//")
            .or_else(|| text.strip_prefix("/*").and_then(|s| s.strip_suffix("*/")))
            .unwrap_or(text);
        for line in contents.lines() {
            let line = line.trim().trim_start_matches('*').trim().to_lowercase();
            let line = line
                .strip_prefix("this file is ")
                .or_else(|| line.strip_prefix("this file was "))
                .unwrap_or(&line);
            if [
                "@generated",
                "automatically generated",
                "auto-generated",
                "autogenerated",
                "generated by",
                "do not edit",
            ]
            .iter()
            .any(|marker| {
                line.strip_prefix(marker)
                    .is_some_and(|rest| rest.is_empty() || !rest.starts_with(char::is_alphanumeric))
            }) {
                return true;
            }
        }
    }
    false
}

pub fn attach_methods(items: &mut [Declaration], coverage: &mut Coverage) {
    let mut declarations = BTreeMap::<(String, Vec<String>), Vec<usize>>::new();
    for (index, item) in items.iter().enumerate() {
        if matches!(item.kind.as_str(), "struct" | "enum" | "union") {
            let mut path = item.module.clone();
            path.push(item.name.clone());
            declarations
                .entry((item.crate_root.clone(), path))
                .or_default()
                .push(index);
        }
    }
    let methods: Vec<_> = items
        .iter()
        .filter(|item| {
            item.kind == "method" && item.impl_trait.is_none() && item.impl_target.is_some()
        })
        .cloned()
        .collect();
    for method in methods {
        let target = method.impl_target.as_ref().unwrap();
        let mut path = method.module.clone();
        let mut rest = target.as_slice();
        if rest.first().is_some_and(|s| s == "crate") {
            path.clear();
            rest = &rest[1..];
        } else if rest.first().is_some_and(|s| s == "self") {
            rest = &rest[1..];
        }
        while rest.first().is_some_and(|s| s == "super") {
            path.pop();
            rest = &rest[1..];
        }
        path.extend_from_slice(rest);
        let matches = declarations.get(&(method.crate_root.clone(), path));
        if let Some(matches) = matches.filter(|matches| matches.len() == 1) {
            let target = &mut items[matches[0]];
            let name = method.name.rsplit("::").next().unwrap().to_string();
            let signature = format!("{} {:?}", method.header, method.attributes);
            target
                .methods
                .entry(name)
                .and_modify(|previous| {
                    previous.push_str(" | ");
                    previous.push_str(&signature);
                })
                .or_insert(signature);
        } else {
            coverage.unresolved_impls.push(json!({"file":method.file,"line":method.line,"target":method.owner,"reason":"target path absent or ambiguous; imports and type aliases are not resolved"}));
        }
    }
}
