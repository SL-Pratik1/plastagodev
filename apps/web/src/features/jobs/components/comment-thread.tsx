import {
  COMMENT_VISIBILITIES,
  COMMENT_VISIBILITY_LABELS,
  type CommentVisibility,
  type Job,
  type JobComment,
} from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Spinner,
  Textarea,
  cn,
  useToast,
  type BadgeProps,
} from '@plastago/ui';
import {
  CheckCheckIcon,
  EyeIcon,
  LockIcon,
  MessageSquareIcon,
  SendIcon,
  TruckIcon,
  UserIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAuth } from '@/features/auth/auth-context';
import { useAddJobComment } from '@/features/jobs/queries';
import { describeError } from '@/lib/error-message';
import { formatDateTime, formatRelative } from '@/lib/format';

/**
 * The job's three comment threads (M2.11, M8.6 · W50, W102).
 *
 * ── Why three threads and not one list with a label ───────────────────────
 * Because the audiences are different and the cost of getting it wrong is not
 * symmetrical. An internal note that reaches a builder is an incident; a message
 * meant for the driver that sits in an internal list never arrives. Separating
 * them makes the audience the thing you pick *before* you write, rather than a
 * dropdown you might not notice beside the Post button.
 *
 * The counts sit on the tabs so an unread driver reply is visible without
 * opening it.
 *
 * ── What this deliberately is not ─────────────────────────────────────────
 * Not a chat product. M8.6 scopes it honestly: *"job-scoped comment threads plus
 * push notification, rather than a general chat product"* — full real-time chat
 * (F20) is v1.1. There is no typing indicator, no presence, no driver-to-driver
 * and no group channel, because Matt confirmed the shape is office ↔ driver on a
 * job. Keeping the conversation attached to the job is better than chat for
 * auditability, which is the reason it was scoped this way.
 */

const THREADS: readonly {
  key: CommentVisibility;
  label: string;
  icon: typeof LockIcon;
  blurb: string;
}[] = [
  {
    key: 'internal',
    label: 'Internal',
    icon: LockIcon,
    blurb: 'Office only. The customer and the driver never see these.',
  },
  {
    key: 'driver',
    label: 'Driver',
    icon: TruckIcon,
    blurb: 'Office ↔ the allocated driver. Pushes to their app immediately.',
  },
  {
    key: 'customer',
    label: 'Customer',
    icon: EyeIcon,
    blurb:
      'Visible to the customer in their portal, and they can reply here. Write it as they will read it.',
  },
];

/** A thread named in the URL — how a notification opens the right one. */
function threadFrom(value: string | null): CommentVisibility {
  return (COMMENT_VISIBILITIES as readonly string[]).includes(value ?? '')
    ? (value as CommentVisibility)
    : 'internal';
}

const BADGE_VARIANT: Record<CommentVisibility, BadgeProps['variant']> = {
  internal: 'outline',
  driver: 'default',
  customer: 'secondary',
};

export function JobCommentThreads({ job }: { job: Job }) {
  const toast = useToast();
  const { can } = useAuth();
  const addComment = useAddJobComment();
  const [params] = useSearchParams();

  // `?thread=customer` from a "message from the customer" notification opens
  // on the reply rather than on the internal notes.
  const [active, setActive] = useState<CommentVisibility>(() => threadFrom(params.get('thread')));
  const [body, setBody] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const thread = THREADS.find((candidate) => candidate.key === active) ?? THREADS[0]!;
  const comments = job.comments.filter((comment) => comment.visibility === active);

  /*
   * Two separate reasons the driver thread may be read-only, and they need
   * different sentences. "You cannot do this" and "there is nobody to send it
   * to" are not the same problem, and collapsing them into one disabled button
   * leaves the user with no idea which applies to them.
   */
  const mayPostToDriver = can('driver-comms');
  const hasDriver = job.driverId !== null;
  const blocked =
    active === 'driver'
      ? !mayPostToDriver
        ? 'Your role cannot message drivers.'
        : !hasDriver
          ? 'Allocate a driver first — there is nobody to send this to yet.'
          : null
      : null;

  const post = async () => {
    const trimmed = body.trim();
    if (!trimmed) {
      setFieldError('Write something before posting.');
      return;
    }
    if (trimmed.length > 2000) {
      setFieldError('That is over the 2,000 character limit. Trim it or attach a document.');
      return;
    }

    setFieldError(null);

    try {
      await addComment.mutateAsync({ id: job.id, draft: { body: trimmed, visibility: active } });
      setBody('');
      toast.success(
        active === 'driver'
          ? `Sent to ${job.driverName ?? 'the driver'}`
          : active === 'customer'
            ? 'Posted to the customer portal'
            : 'Internal note added',
        active === 'driver'
          ? 'It has been pushed to their app and will show on the job.'
          : active === 'customer'
            ? 'They have been notified and can reply from the pickup.'
            : undefined,
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Comments</CardTitle>
        <p className="text-xs text-muted-foreground">
          Three separate threads. Pick the audience before you write — that is the whole point of
          keeping them apart.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/*
          A radio group rather than the Tabs primitive: this control chooses who
          will READ what you are about to write, so it belongs to the form, and
          the browser's own radio semantics announce it as a choice with a
          current selection. Tabs announce it as navigation.
        */}
        <fieldset>
          <legend className="sr-only">Choose a thread</legend>
          <div className="flex flex-wrap gap-2">
            {THREADS.map((option) => {
              const count = job.comments.filter(
                (comment) => comment.visibility === option.key,
              ).length;
              const selected = option.key === active;

              return (
                <label
                  key={option.key}
                  className={cn(
                    'focus-within:ring-ring/50 flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors focus-within:ring-2',
                    selected
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  <input
                    type="radio"
                    name="comment-thread"
                    className="sr-only"
                    checked={selected}
                    onChange={() => {
                      setActive(option.key);
                      setFieldError(null);
                    }}
                  />
                  <option.icon aria-hidden className="size-3.5 shrink-0" />
                  {option.label}
                  {count > 0 && (
                    <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">
                      {count}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>

        <p className="text-xs text-muted-foreground">{thread.blurb}</p>

        {comments.length === 0 ? (
          <EmptyState
            icon={MessageSquareIcon}
            title={`No ${thread.label.toLowerCase()} comments yet`}
            description={thread.blurb}
          />
        ) : (
          <ol className="space-y-3">
            {comments.map((comment) => (
              <CommentBubble key={comment.id} comment={comment} />
            ))}
          </ol>
        )}

        {blocked ? (
          <Alert variant="info" title="This thread is read-only for you right now">
            {blocked}
          </Alert>
        ) : (
          <div className="space-y-3 border-t border-border pt-4">
            <Field
              id={`comment-${active}`}
              label={`Post to the ${thread.label.toLowerCase()} thread`}
              error={fieldError ?? undefined}
              hint={
                active === 'driver'
                  ? `${job.driverName ?? 'The driver'} gets a push notification straight away.`
                  : active === 'customer'
                    ? 'This appears on the pickup in their portal, and they are notified.'
                    : 'Stays inside the office.'
              }
            >
              {(control) => (
                <Textarea
                  {...control}
                  rows={3}
                  maxLength={2000}
                  value={body}
                  placeholder={
                    active === 'driver'
                      ? 'Gate code is 4417 — supervisor on site from 7am.'
                      : active === 'customer'
                        ? 'Your pickup is booked for Thursday; the board needs to be bagged by 7am.'
                        : 'Rang the supervisor twice, no answer. Trying again Thursday.'
                  }
                  onChange={(event) => {
                    setBody(event.target.value);
                    setFieldError(null);
                  }}
                />
              )}
            </Field>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground tabular-nums">
                {body.length} / 2,000
              </span>
              <Button
                size="sm"
                disabled={addComment.isPending || body.trim().length === 0}
                onClick={() => void post()}
              >
                {addComment.isPending && <Spinner label="Posting" />}
                <SendIcon aria-hidden />
                {active === 'driver' ? 'Send to driver' : 'Post comment'}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One comment.
 *
 * Replies — the driver's on the driver thread, the customer's on the customer
 * thread — are indented and tinted so a thread reads as a conversation with two
 * sides rather than a log with a name column — which is what "communicate with
 * drivers" (W102) actually means in use.
 */
function CommentBubble({ comment }: { comment: JobComment }) {
  const isReply = comment.fromDriver || comment.fromCustomer;

  return (
    <li
      className={cn(
        'rounded-lg border p-3',
        isReply ? 'ml-6 border-brand-500/35 bg-brand-500/6' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-sm font-medium">{comment.author}</p>
        {comment.fromDriver && (
          <Badge variant="outline">
            <TruckIcon aria-hidden className="size-3" />
            Driver
          </Badge>
        )}
        {comment.fromCustomer && (
          <Badge variant="outline">
            <UserIcon aria-hidden className="size-3" />
            Customer
          </Badge>
        )}
        {!isReply && comment.visibility !== 'internal' && (
          <Badge variant={BADGE_VARIANT[comment.visibility]}>
            {COMMENT_VISIBILITY_LABELS[comment.visibility]}
          </Badge>
        )}
        <span
          className="text-xs text-muted-foreground tabular-nums"
          title={formatDateTime(comment.at)}
        >
          {formatRelative(comment.at)}
        </span>
      </div>

      <p className="mt-1 text-sm whitespace-pre-wrap">{comment.body}</p>

      {/* M8.6 — "did it reach them" is the first question about a message to
          someone on the road, so the delivery state is on the message itself. */}
      {comment.deliveredAt !== null && !comment.fromDriver && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
          <CheckCheckIcon aria-hidden className="size-3 shrink-0 text-success" />
          Delivered {formatRelative(comment.deliveredAt)}
        </p>
      )}
    </li>
  );
}
