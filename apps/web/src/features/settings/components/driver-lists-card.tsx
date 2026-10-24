import {
  DRIVER_LIST_LABELS,
  type DriverListName,
  type DriverListOption,
  type DriverListWrite,
} from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  ErrorState,
  Field,
  Input,
  Skeleton,
  Switch,
  useToast,
} from '@plastago/ui';
import { PencilIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useCurrentUser } from '@/features/auth/auth-context';
import { describeError } from '@/lib/error-message';
import { isServiceError } from '@/services/service-error';
import { useDriverLists, useSaveDriverList } from '../queries';

/** What each list is for, in the office's words. */
const LIST_HINTS: Record<DriverListName, string> = {
  siteHazards: 'What the driver can tick on the site risk assessment.',
  riskControls: 'What the driver did about the hazards, on the same form.',
  cantCollectReasons: 'Why the driver could not collect — the reason a futile fee is charged on.',
  contaminationTypes: 'What was in a contaminated load.',
};

/** The server's reason, which is what the person needs to fix it. */
function failure(error: unknown): { title: string; detail?: string } {
  if (isServiceError(error) && error.message.trim().length > 0) return { title: error.message };
  const described = describeError(error);
  return { title: described.title, detail: described.detail };
}

/** A label as the server will compare it: trimmed, any case. */
function sameLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Why a new label cannot be saved, or null. Mirrors the server's rules. */
function labelProblem(label: string, options: readonly DriverListOption[]): string | null {
  const trimmed = label.trim();
  if (trimmed.length < 2) return 'Write the option out — at least two characters';
  if (trimmed.length > 80) return 'Keep it under 80 characters';
  const match = options.find((option) => sameLabel(option.label, trimmed));
  if (match?.active) return `"${trimmed}" is already on the list`;
  if (match) return `"${match.label}" is on the list, switched off — switch it back on instead`;
  return null;
}

/**
 * Settings → Driver lists (Matt, 21 Oct: *"I need to be able to edit what
 * they're asked from the admin section"*).
 *
 * ⚠️ An option is switched off, never deleted, and its wording never changes:
 * jobs and reports keep the option's key and read the wording from here, so a
 * deleted or reworded option would rewrite what a driver answered last month.
 * "Change wording" therefore switches the old one off and adds the new one.
 *
 * Each change saves straight away — there is no form to forget to submit.
 */
export function DriverListsCard({ list }: { list: DriverListName }) {
  const lists = useDriverLists();
  const canEdit = useCurrentUser().role === 'super-admin';

  if (lists.error) {
    const described = describeError(lists.error);
    return (
      <ErrorState
        title={described.title}
        description={described.detail}
        onRetry={() => void lists.refetch()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Alert variant="info" title="What the driver app asks">
        Switching an option off hides it from drivers; past jobs keep the wording they were
        answered with.
        {canEdit ? '' : ' Only a Super Admin can change these lists.'}
      </Alert>
      {lists.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <DriverListEditor key={list} name={list} options={lists.data[list]} canEdit={canEdit} />
      )}
    </div>
  );
}


function DriverListEditor({
  name,
  options,
  canEdit,
}: {
  name: DriverListName;
  options: readonly DriverListOption[];
  canEdit: boolean;
}) {
  const toast = useToast();
  const save = useSaveDriverList();
  const [newLabel, setNewLabel] = useState('');
  const [newError, setNewError] = useState<string | null>(null);
  const [rewording, setRewording] = useState<DriverListOption | null>(null);

  const title = DRIVER_LIST_LABELS[name];
  const activeCount = options.filter((option) => option.active).length;
  const asWritten = (): DriverListWrite['options'] =>
    options.map(({ key, label, active }) => ({ key, label, active }));

  const write = async (next: DriverListWrite['options'], success: string): Promise<boolean> => {
    try {
      await save.mutateAsync({ list: name, write: { options: next } });
      toast.success(success, `${title} is updated. Drivers see it from their next screen.`);
      return true;
    } catch (caught) {
      const { title: problem, detail } = failure(caught);
      toast.error(problem, detail);
      return false;
    }
  };

  const toggle = (option: DriverListOption) => {
    if (option.active && activeCount === 1) {
      toast.error('Keep at least one option switched on', 'Drivers need something to pick.');
      return;
    }
    void write(
      asWritten().map((row) => (row.key === option.key ? { ...row, active: !row.active } : row)),
      option.active ? `"${option.label}" switched off` : `"${option.label}" switched on`,
    );
  };

  const add = async () => {
    const problem = labelProblem(newLabel, options);
    if (problem) {
      setNewError(problem);
      return;
    }
    const label = newLabel.trim();
    if (await write([...asWritten(), { key: null, label, active: true }], `"${label}" added`)) {
      setNewLabel('');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{LIST_HINTS[name]}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="divide-y divide-border rounded-lg border border-border">
          {options.map((option) => (
            <li key={option.key} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <span
                className={
                  option.active ? 'min-w-0 flex-1 text-sm' : 'min-w-0 flex-1 text-sm text-muted-foreground'
                }
              >
                {option.label}
              </span>
              {!option.active && <Badge variant="outline">Off</Badge>}
              {canEdit && (
                <>
                  {option.active && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={save.isPending}
                      onClick={() => {
                        setRewording(option);
                      }}
                    >
                      <PencilIcon aria-hidden />
                      Change wording
                    </Button>
                  )}
                  <Switch
                    checked={option.active}
                    disabled={save.isPending}
                    aria-label={`${option.active ? 'Switch off' : 'Switch on'} "${option.label}"`}
                    onCheckedChange={() => {
                      toggle(option);
                    }}
                  />
                </>
              )}
            </li>
          ))}
        </ul>

        {canEdit && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <Field
              id={`new-${name}`}
              label="Add an option"
              error={newError ?? undefined}
              className="min-w-56 flex-1"
            >
              {(control) => (
                <Input
                  {...control}
                  value={newLabel}
                  maxLength={80}
                  onChange={(event) => {
                    setNewLabel(event.target.value);
                    setNewError(null);
                  }}
                />
              )}
            </Field>
            <Button type="submit" variant="outline" disabled={save.isPending}>
              <PlusIcon aria-hidden />
              Add
            </Button>
          </form>
        )}
      </CardContent>

      <RewordDialog
        option={rewording}
        options={options}
        pending={save.isPending}
        onClose={() => {
          setRewording(null);
        }}
        onSave={async (label) => {
          if (!rewording) return;
          const saved = await write(
            asWritten().flatMap((row) =>
              row.key === rewording.key
                ? [{ ...row, active: false }, { key: null, label, active: true }]
                : [row],
            ),
            `"${label}" replaces "${rewording.label}"`,
          );
          if (saved) setRewording(null);
        }}
      />
    </Card>
  );
}

/**
 * New wording for an option — saved as a new option, with the old one switched
 * off, so a past answer keeps the words it was given in.
 */
function RewordDialog({
  option,
  options,
  pending,
  onClose,
  onSave,
}: {
  option: DriverListOption | null;
  options: readonly DriverListOption[];
  pending: boolean;
  onClose: () => void;
  onSave: (label: string) => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [forKey, setForKey] = useState<string | null>(null);

  // Seed the box each time the dialog opens, and forget it once closed.
  if (option && option.key !== forKey) {
    setForKey(option.key);
    setLabel(option.label);
    setError(null);
  }
  if (!option && forKey !== null) setForKey(null);

  const submit = () => {
    if (!option) return;
    if (sameLabel(label, option.label)) {
      setError('Change the wording first');
      return;
    }
    const others = options.filter((candidate) => candidate.key !== option.key);
    const problem = labelProblem(label, others);
    if (problem) {
      setError(problem);
      return;
    }
    void onSave(label.trim());
  };

  return (
    <Dialog
      open={option !== null}
      onClose={onClose}
      title="Change wording"
      description="Drivers see the new wording from now on. Past jobs keep the old wording."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={submit}>
            Save wording
          </Button>
        </>
      }
    >
      <Field id="reword-label" label="New wording" error={error ?? undefined} required>
        {(control) => (
          <Input
            {...control}
            value={label}
            maxLength={80}
            onChange={(event) => {
              setLabel(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        )}
      </Field>
    </Dialog>
  );
}
