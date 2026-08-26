/**
 * @plastago/ui — shadcn/ui primitives owned in-repo (§6A.1).
 *
 * These components are copied in and owned, not a black-box dependency. Add more
 * with `npx shadcn@latest add <component>` from `packages/ui` — `components.json`
 * is already configured — then export it here.
 *
 * ── Why there is no Radix dependency ──────────────────────────────────────
 * The overlay primitives here (Dialog, Drawer, Menu, Tabs, Select, Checkbox,
 * Switch) are built on platform features instead: the native `<dialog>` element
 * for focus trapping and the top layer, a real `<select>` so phones get the
 * system picker, real `<input>`s so labels and form submission behave, and the
 * documented ARIA tab pattern for Tabs. Each carries a note explaining what the
 * platform gives us and where the limits are.
 *
 * If a future screen needs something the platform genuinely cannot do —
 * combobox with async search, virtualised listbox, anchored popover that flips
 * at the viewport edge — add `@radix-ui/*` for that one component rather than
 * rewriting these.
 */

export { cn } from './lib/utils.js';

// ── Actions and content ────────────────────────────────────────────────────
export { Button, buttonVariants, type ButtonProps } from './components/button.js';
export { Badge, badgeVariants, type BadgeProps } from './components/badge.js';
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from './components/card.js';
export { Alert, alertVariants, type AlertProps } from './components/alert.js';
export { Avatar, initialsOf, type AvatarProps } from './components/avatar.js';
export { Separator, type SeparatorProps } from './components/separator.js';

// ── Forms ──────────────────────────────────────────────────────────────────
export { Input } from './components/input.js';
export { Label } from './components/label.js';
export { Textarea } from './components/textarea.js';
export { Select } from './components/select.js';
export { Checkbox, type CheckboxProps } from './components/checkbox.js';
export { Switch, type SwitchProps } from './components/switch.js';
export { Field, type FieldProps, type FieldControlProps } from './components/field.js';
export { PinInput, type PinInputProps } from './components/pin-input.js';

// ── Overlays ───────────────────────────────────────────────────────────────
export { Dialog, type DialogProps } from './components/dialog.js';
export { ConfirmDialog, type ConfirmDialogProps } from './components/confirm-dialog.js';
export { Drawer, type DrawerProps } from './components/drawer.js';
export {
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  type MenuProps,
  type MenuItemProps,
} from './components/menu.js';

// ── Navigation ─────────────────────────────────────────────────────────────
export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsPanel,
  type TabsProps,
  type TabsListProps,
  type TabsTriggerProps,
  type TabsPanelProps,
} from './components/tabs.js';
export { Pagination, type PaginationProps } from './components/pagination.js';

// ── Tables ─────────────────────────────────────────────────────────────────
export {
  TableContainer,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
  type TableHeadProps,
  type TableCellProps,
} from './components/table.js';

// ── States ─────────────────────────────────────────────────────────────────
export { Spinner } from './components/spinner.js';
export { Skeleton, SkeletonText } from './components/skeleton.js';
export { EmptyState, type EmptyStateProps } from './components/empty-state.js';
export { ErrorState, type ErrorStateProps } from './components/error-state.js';

// ── Feedback ───────────────────────────────────────────────────────────────
export {
  ToastProvider,
  useToast,
  type ToastApi,
  type ToastOptions,
  type ToastVariant,
} from './components/toast.js';
