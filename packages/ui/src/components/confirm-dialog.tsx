import type { ReactNode } from 'react';
import { Button } from './button.js';
import { Dialog } from './dialog.js';
import { Spinner } from './spinner.js';

export interface ConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: ReactNode;
  /** Say what will happen, in the user's terms. Not "Are you sure?". */
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `destructive` for anything that removes, revokes or cannot be undone. */
  tone?: 'default' | 'destructive';
  pending?: boolean;
}

/**
 * Confirmation before an action that is hard to undo.
 *
 * Two rules this component enforces so individual screens cannot get them wrong:
 *
 *  1. **The confirm button is labelled with the verb**, so "Revoke access" — not
 *     "OK". A user skimming a dialog reads the button, not the paragraph.
 *  2. **Cancel is the default focus and Escape works.** The safe path is the
 *     easy one; the destructive path takes a deliberate move.
 *
 * A confirmation is only worth showing when the action is genuinely hard to
 * reverse. Guarding routine saves with a dialog teaches people to dismiss
 * dialogs unread, which is worse than not having them.
 */
export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  pending = false,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={pending ? () => undefined : onCancel}
      title={title}
      description={description}
      size="sm"
      dismissible={!pending}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={pending}
            autoFocus
            className="w-full sm:w-auto"
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={tone === 'destructive' ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={pending}
            className="w-full sm:w-auto"
          >
            {pending && <Spinner className="text-current" />}
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
