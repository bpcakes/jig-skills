# React Component and Hook API Review Rules

Use this reference as the detailed checklist for `react-hooks-component-api-review` when reviewing nontrivial exported React component or hook APIs. Keep findings concrete: identify the invalid or unclear consumer behavior, explain why it matters, and show the smallest API/model change that fixes it.

## Core checks

### 1. Props that allow invalid combinations

Flag props where the type allows combinations the component cannot correctly render or where one prop only makes sense with another.

Common red flags:

- Multiple optional props where at least one is required.
- Mutually exclusive props can be passed together: `href` and `onClick`, `icon` and `children`, `value` and `defaultValue`, `error` and `success`.
- Props are ignored unless another prop is present.
- State triples such as `loading?: boolean`, `error?: Error`, `data?: T`.
- Mode-specific props are optional on the base type: `multiple?: boolean` with `value?: T | T[]`.

Prefer discriminated unions with `never` for impossible props.

```ts
// Bad: every invalid combination is allowed.
type AlertProps = {
  success?: boolean;
  error?: boolean;
  message?: string;
  errorMessage?: string;
};

// Better: the mode determines the valid fields.
type AlertProps =
  | { status: 'success'; message: string; errorMessage?: never }
  | { status: 'error'; errorMessage: string; message?: never }
  | { status: 'info'; message: string; errorMessage?: never };
```

For one-of-many content contracts:

```ts
type EmptyStateProps =
  | { kind: 'message'; message: string; render?: never }
  | { kind: 'custom'; render: () => React.ReactNode; message?: never };
```

Reviewer standard: do not merely say "use a union". Show the actual discriminant and the forbidden `never` props.

### 2. Boolean flag explosions

A boolean is fine for one independent yes/no capability: `disabled`, `required`, `readOnly`, `open`, `multiple` if it does not alter other prop types, or `isLoading` when it is truly independent.

Flag booleans when they encode modes, variants, async states, mutually exclusive visual styles, or behavior changes that affect required props.

```ts
// Bad
type ButtonProps = {
  primary?: boolean;
  secondary?: boolean;
  danger?: boolean;
  loading?: boolean;
};

// Better
type ButtonProps = {
  variant?: 'primary' | 'secondary' | 'danger';
  state?: 'idle' | 'loading';
};
```

If two or more booleans can create a nonsensical combination, force a discriminant.

```ts
// Bad
type FetchPanelProps<T> = {
  isLoading?: boolean;
  isError?: boolean;
  data?: T;
  error?: Error;
};

// Better
type FetchPanelProps<T> =
  | { status: 'loading'; data?: never; error?: never }
  | { status: 'success'; data: T; error?: never }
  | { status: 'error'; error: Error; data?: never }
  | { status: 'empty'; data?: never; error?: never };
```

### 3. Controlled/uncontrolled contracts

Form controls and interactive components must clearly state who owns the state.

Flag:

- `value?`, `defaultValue?`, and `onChange?` all optional in one flat props type.
- `value` can be provided without a value-change callback, unless the component has an explicit read-only branch.
- `value` and `defaultValue` can be provided together.
- `checked` and `defaultChecked` can be provided together.
- Naming makes it unclear whether `onChange` receives a DOM event or a domain value.
- The component can switch between controlled and uncontrolled mode over its lifetime.

Use a union.

```ts
type Controlled<T> = {
  value: T;
  onValueChange: (value: T) => void;
  defaultValue?: never;
};

type Uncontrolled<T> = {
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  value?: never;
};

type ReadOnlyControlled<T> = {
  value: T;
  readOnly: true;
  onValueChange?: never;
  defaultValue?: never;
};

type TextFieldProps = CommonTextFieldProps &
  (Controlled<string> | Uncontrolled<string> | ReadOnlyControlled<string>);
```

Use `onChange` for native DOM event compatibility. Use `onValueChange`, `onCheckedChange`, `onOpenChange`, or `onSelectionChange` for domain value callbacks.

```ts
type NativeInputProps = {
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
};

type DomainInputProps = {
  onValueChange?: (value: string) => void;
};
```

For selects, check whether `multiple` changes the `value` and callback type.

```ts
type SingleSelect<T> = {
  multiple?: false;
  value: T | null;
  onValueChange: (value: T | null) => void;
};

type MultiSelect<T> = {
  multiple: true;
  value: readonly T[];
  onValueChange: (value: readonly T[]) => void;
};

type SelectProps<T> = CommonSelectProps<T> & (SingleSelect<T> | MultiSelect<T>);
```

### 4. `children` contracts

`children?: React.ReactNode` is acceptable for simple wrappers that render arbitrary content without inspecting it. It is too broad when count, type, order, function signature, accessibility, or slots matter.

Flag broad `children` when:

- The component expects exactly one element and calls `cloneElement`.
- The child must be a function/render prop.
- The component has named regions like trigger/content/footer/actions.
- Text-only content is required for measurement, labels, or accessibility.
- Children are forbidden but the props type permits them.
- A compound component depends on specific child roles.

Prefer explicit slots or render-prop signatures.

```ts
// Bad: caller can pass anything, but implementation expects a function.
type DataLoaderProps<T> = {
  children?: React.ReactNode;
};

// Better
type DataLoaderProps<T> = {
  children: (state: { data: T; refresh: () => void }) => React.ReactNode;
};
```

```ts
// Bad: order and presence are implicit in children.
type DialogProps = {
  children?: React.ReactNode;
};

// Better when slots are the real contract.
type DialogProps = {
  title: React.ReactNode;
  description?: React.ReactNode;
  body: React.ReactNode;
  actions?: React.ReactNode;
};
```

```ts
// Leaf component: forbid children.
type TextInputProps = {
  children?: never;
  value: string;
};
```

Be careful with "only allow `<Tab />` children" advice. TypeScript cannot reliably enforce exact React child component types after JSX element creation. If correctness matters, prefer structured props such as `tabs: readonly TabSpec[]`, named slots, or runtime validation/dev warnings.

### 5. Callback prop types

Callbacks are part of the public contract. They should describe exactly what the consumer receives and whether the component uses the return value.

Flag:

- `Function`
- `any`
- `(...args: any[]) => void`
- `onChange?: (value: any) => void`
- `onClick?: (event: unknown) => void`
- Callbacks named generically while receiving domain data: `onAction`, `onEvent`, `onChange`.
- Callback return values typed as meaningful but ignored by implementation.

Prefer precise React event handlers for DOM events:

```ts
type ButtonProps = {
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
};

type FormProps = {
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
};

type InputProps = {
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
};
```

Prefer domain callbacks when consumers should not reason about DOM events:

```ts
type ComboboxProps<TOption> = {
  options: readonly TOption[];
  getOptionId: (option: TOption) => string;
  onOptionSelect: (option: TOption, context: { id: string }) => void;
};
```

Name callbacks by the thing that changed or happened:

- `onValueChange(value)` for value controls.
- `onOpenChange(open)` for disclosure state.
- `onSelectionChange(selection)` for selected item(s).
- `onDismiss(reason)` if close behavior depends on reason.
- `onSubmit(values)` for form domain payloads.

If a callback may be async and the component awaits it, type it as `void | Promise<void>` and verify the implementation handles pending and rejection states. If the component ignores the return value, keep the return type `void`.

### 6. Generic component props

Generics are useful when they preserve inference from consumer data. They are harmful when consumers must manually thread type parameters through JSX or understand internal types.

Flag:

- A generic parameter appears only once.
- Consumers usually need `<Component<Foo>>` annotations.
- Generic constraints are too broad: `T extends object`, `Record<string, any>`, `any[]`.
- Internal implementation types leak into public props.
- The API requires consumers to provide both `data` and generic mappers with vague names.

Prefer inference from concrete props.

```ts
// Good: TValue is inferred from options and value.
type SelectOption<TValue extends string | number> = {
  value: TValue;
  label: string;
};

type SelectProps<TValue extends string | number> = {
  options: readonly SelectOption<TValue>[];
  value: TValue | null;
  onValueChange: (value: TValue | null) => void;
};
```

For object options, require clear extractors instead of relying on hidden field names.

```ts
type ListBoxProps<TItem> = {
  items: readonly TItem[];
  getItemId: (item: TItem) => string;
  getItemLabel: (item: TItem) => React.ReactNode;
  selectedItem: TItem | null;
  onSelectedItemChange: (item: TItem | null) => void;
};
```

If a design-system component has one dominant domain use, prefer a non-generic wrapper around a generic primitive.

### 7. Polymorphic `as` props

Polymorphic components are easy to make unsound. Treat `as` as an advanced primitive API, not a default escape hatch.

Flag:

- `as?: React.ElementType` combined with `...rest: any`.
- Ref type does not change with `as`.
- Invalid attributes are allowed, such as `href` on a button branch.
- Domain behavior changes by element type but the props do not encode the mode.
- The call-site type is harder to understand than separate components or discriminated variants.

For domain components, prefer explicit unions.

```ts
type ButtonLikeProps =
  | {
      kind: 'button';
      type?: 'button' | 'submit' | 'reset';
      onClick?: React.MouseEventHandler<HTMLButtonElement>;
      href?: never;
    }
  | {
      kind: 'link';
      href: string;
      target?: React.HTMLAttributeAnchorTarget;
      onClick?: React.MouseEventHandler<HTMLAnchorElement>;
      type?: never;
    };
```

For low-level primitives that truly need `as`, ensure the public type uses `React.ElementType`, `React.ComponentPropsWithoutRef<E>` or `ComponentPropsWithRef<E>`, omits prop collisions, and preserves ref typing. Do not expose `as` simply to avoid designing the domain API.

### 8. Native prop inheritance and prop collision

Wrapper components often need native props. Inherit the correct native contract and remove collisions with domain props.

Prefer:

```ts
type ButtonProps = {
  variant?: 'primary' | 'secondary';
} & Omit<React.ComponentPropsWithoutRef<'button'>, 'color'>;
```

For ref-forwarding primitives, consider `ComponentPropsWithRef<'button'>` and ensure `forwardRef` matches the element.

Flag:

- `React.HTMLProps<T>` or `React.HTMLAttributes<T>` used when it widens native props too much.
- Domain props collide with native names: `size`, `color`, `label`, `onChange`, `type`.
- `...rest` accepts attributes that the component never forwards.
- The component forwards props to a different element than the inherited type says.

If overriding a native callback with a domain callback, use `Omit` and rename the domain callback if needed.

```ts
type TextboxProps = {
  value: string;
  onValueChange: (value: string) => void;
} & Omit<React.ComponentPropsWithoutRef<'input'>, 'value' | 'defaultValue' | 'onChange' | 'children'>;
```

### 9. Implementation details leaking into public API

Public props should describe what the consumer wants, not how the component is implemented.

Flag props such as:

- `data`, `item`, `config`, `options` when the domain noun is known.
- `isCustom`, `customRenderer`, `overrideComponent`, `internalState`, `usePortal`, `portalRoot`, `containerRef`, `menuRef`.
- `components` maps that expose every internal subpart without clear stability guarantees.
- Props that name CSS or DOM structure rather than component behavior.
- Callbacks exposing indexes or internal IDs when the consumer needs domain objects.

Prefer domain names and stable extension points.

```ts
// Bad
type UserMenuProps = {
  data: unknown[];
  config?: object;
  customRenderer?: Function;
};

// Better
type UserMenuProps = {
  users: readonly User[];
  selectedUserId?: string;
  renderUser?: (user: User) => React.ReactNode;
  onUserSelect?: (user: User) => void;
};
```

Escape hatches are acceptable for primitives, but they must be intentionally named and bounded: `className`, `style`, `slotProps`, `data-testid`, `portalContainer`, or `renderX` may be reasonable depending on the design-system conventions.

### 10. Naming that hides behavior

Names should reduce guessing at call sites.

Flag vague names:

- `data`, `item`, `config`, `options`, `payload`, `meta`, `state`, `value` when the domain is more specific.
- `onChange` when the callback does not receive the native event and the changed thing is not obvious.
- `type` when it means visual variant, behavior mode, native button type, or domain classification ambiguously.
- `disabled` used to mean loading, unavailable, permission denied, or read-only.

Prefer:

- Collections: `rows`, `columns`, `users`, `products`, `choices`, `menuItems`, `validationRules`.
- Visual modes: `variant`, `tone`, `density`, `size` with documented literal values.
- State modes: `status`, `mode`, `state` only with clear domain literals.
- Domain callbacks: `onUserSelect`, `onFieldBlur`, `onQueryChange`, `onOpenChange`.

### 11. Compound components

Compound components are public APIs, not just JSX structure.

Flag:

- Subcomponents silently require a parent provider but can be imported and rendered alone without warning.
- Required child roles are not documented or represented.
- Parent props and child props duplicate or contradict each other.
- Child order matters but the API pretends children are arbitrary.
- Compound API exposes implementation component names instead of domain roles.

Prefer stable roles and explicit context boundaries.

```ts
Tabs.Root
Tabs.List
Tabs.Trigger
Tabs.Panel
```

For strict data-driven requirements, structured props may be safer than compound children:

```ts
type TabsProps = {
  tabs: readonly { id: string; label: React.ReactNode; panel: React.ReactNode }[];
  value: string;
  onValueChange: (id: string) => void;
};
```

When keeping compound components, add dev-time runtime checks for missing providers or invalid structure if TypeScript cannot enforce it.

### 12. Reusable hooks

Hook APIs are also public contracts.

Flag:

- Hook parameters are vague config bags with many optional fields.
- Return tuple has more than two or three positions and is easy to misread.
- Hook exposes reducers, refs, timers, caches, or internal status flags that callers should not control.
- Hook returns callbacks typed with `any` or unstable payloads.
- Controlled/uncontrolled ownership is unclear.

Prefer object parameters and returns for multi-field APIs.

```ts
type UseDisclosureOptions =
  | { open: boolean; onOpenChange: (open: boolean) => void; defaultOpen?: never }
  | { defaultOpen?: boolean; onOpenChange?: (open: boolean) => void; open?: never };

type UseDisclosureReturn = {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerProps: React.ComponentPropsWithoutRef<'button'>;
  contentProps: React.ComponentPropsWithoutRef<'div'>;
};
```

Tuple returns are acceptable for common conventions like `[state, setState]`. Otherwise prefer named return fields.

## Review heuristics by component type

### Design-system primitives

Be strict about DOM prop inheritance, refs, accessibility, polymorphic `as`, `className`/`style` escape hatches, and variant naming. Primitives can expose low-level concepts, but the low-level contract must remain sound.

### Domain components

Be strict about domain naming. A domain component should not expose generic bags like `data`, `config`, `item`, or internal renderer maps when it can expose `users`, `invoice`, `lineItems`, `filters`, or `actions`.

### Form controls

Always check controlled/uncontrolled mode, value type, default value type, change callback payload, native event forwarding, read-only behavior, disabled behavior, validation/error props, labels, and accessibility-critical props.

### Layout primitives

Check whether spacing, alignment, direction, wrap, and responsive props form a coherent token contract. Avoid boolean combinations like `horizontal`, `vertical`, `center`, `between` when a `direction`, `align`, and `justify` model is clearer.

### Reusable hooks

Check whether hook options and returns encode ownership, lifecycle, callback semantics, and domain payloads without exposing implementation machinery.

## Non-issues and acceptable tradeoffs

Do not over-report:

- `children?: React.ReactNode` is fine for simple containers, cards, stacks, and wrappers that truly render arbitrary content.
- Independent booleans are fine when they do not interact with other props.
- Optional props are fine when each has a clear default and does not affect required props.
- Generic components are fine when type inference works from props and prevents consumer casts.
- `as` is acceptable for foundational primitives if ref, prop collision, and native attribute typing are handled.
- `className`, `style`, `id`, `ref`, `aria-*`, and `data-*` are normal escape hatches for reusable UI components.
- Runtime checks may be necessary for compound child structure because TypeScript cannot enforce every JSX composition rule.
