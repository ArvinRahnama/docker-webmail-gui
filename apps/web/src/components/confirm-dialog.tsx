import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/cn';

/**
 * `ConfirmDialog` — the one destructive-confirmation component every
 * screen in this app uses, implementing UX_ARCHITECTURE.md §8's four
 * tiers so the escalation is consistent everywhere rather than
 * improvised per screen:
 *
 *  1. **Confirm** — Cancel / Confirm, no default focus on the destructive button.
 *  2. **Confirm + consequence** — `description` states the operational impact.
 *  3. **Type-to-confirm + impact summary** — `resourceName` must be typed
 *     exactly; `impactSummary` is required and rendered above the input.
 *  4. **Type-to-confirm + pre-flight + backup gate** — tier 3 plus
 *     `preflight` content and either a verified backup (`backup.verified`)
 *     or an explicit checked acknowledgement that none exists.
 *
 * Rules that hold at every tier (§8): the destructive action is never the
 * default-focused element (`AlertDialogContent`'s own focus trap lands on
 * the dialog, not a button — this component never calls `.focus()` on
 * Confirm), and it is the only button ever styled `destructive`; Cancel
 * always renders alongside it.
 */
export type ConfirmTier = 1 | 2 | 3 | 4;

export interface ConfirmDialogBackupStatus {
  readonly verified: boolean;
  /** e.g. "Verified 3 hours ago" or "No backup on record". Always shown — never just a checkmark/cross (§2 principle 5). */
  readonly description: string;
}

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tier: ConfirmTier;
  readonly title: string;
  /** Tier 1: the confirmation question. Tier 2+: must additionally state the operational consequence. */
  readonly description: ReactNode;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** Colours the confirm button `destructive`. Still never the *only* prominent button — Cancel always renders too. */
  readonly destructive?: boolean;
  readonly pending?: boolean;
  readonly onConfirm: () => void;
  // The tier 3+ fields below are explicitly `| undefined` (not bare
  // optionals) because a caller whose tier varies at runtime (e.g. "tier
  // 3 only when this alias has dependents, tier 2 otherwise" —
  // aliases-page.tsx) passes them as `condition ? value : undefined`.
  // exactOptionalPropertyTypes treats that differently from omitting the
  // prop outright.
  /** Required content for tier 3+: exact resource identity, what is destroyed, dependents, reversibility (§8). */
  readonly impactSummary?: ReactNode | undefined;
  /** The exact string the admin must type to enable Confirm, tier 3+. */
  readonly resourceName?: string | undefined;
  /** Tier 4 only: full pre-flight report content. */
  readonly preflight?: ReactNode | undefined;
  /** Tier 4 only: backup gate — a verified backup, or the admin must tick the acknowledgement checkbox. */
  readonly backup?: ConfirmDialogBackupStatus | undefined;
}

function tierRequiresTypedConfirmation(tier: ConfirmTier): boolean {
  return tier >= 3;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  tier,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  pending = false,
  onConfirm,
  impactSummary,
  resourceName,
  preflight,
  backup,
}: ConfirmDialogProps) {
  const [typedName, setTypedName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const inputId = useId();
  const acknowledgeId = useId();
  const impactId = useId();

  // Every reopen starts clean — a stale typed value or checked
  // acknowledgement carrying over from a *previous* confirmation (e.g.
  // the admin cancelled, then opened the dialog for a different mailbox)
  // must never silently pre-satisfy this one.
  useEffect(() => {
    if (open) {
      setTypedName('');
      setAcknowledged(false);
    }
  }, [open]);

  if (tier >= 3 && (resourceName === undefined || impactSummary === undefined)) {
    throw new Error(
      'ConfirmDialog: tier 3 and 4 require both `resourceName` and `impactSummary` (UX_ARCHITECTURE.md §8).',
    );
  }
  if (tier === 4 && backup === undefined) {
    throw new Error('ConfirmDialog: tier 4 requires `backup` (UX_ARCHITECTURE.md §8 backup gate).');
  }

  const typedMatches = !tierRequiresTypedConfirmation(tier) || typedName === resourceName;
  const backupGateSatisfied = tier < 4 || backup!.verified || acknowledged;
  const canConfirm = typedMatches && backupGateSatisfied && !pending;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent aria-describedby={impactSummary ? impactId : undefined}>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {tier >= 3 ? (
              <AlertTriangle className="size-5 text-status-critical-fg" aria-hidden="true" />
            ) : null}
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {impactSummary ? (
          <div
            id={impactId}
            className="rounded-md border border-status-critical-fg/30 bg-status-critical-bg px-3 py-2.5 text-body-sm text-text-primary"
          >
            {impactSummary}
          </div>
        ) : null}

        {tier === 4 && preflight ? (
          <div className="rounded-md border border-border-default bg-bg-inset px-3 py-2.5 text-body-sm text-text-secondary">
            {preflight}
          </div>
        ) : null}

        {tier === 4 && backup ? (
          <div
            className={cn(
              'flex flex-col gap-2 rounded-md border px-3 py-2.5 text-body-sm',
              backup.verified
                ? 'border-status-healthy-fg/30 bg-status-healthy-bg text-status-healthy-fg'
                : 'border-status-warning-fg/30 bg-status-warning-bg text-status-warning-fg',
            )}
          >
            <span>{backup.description}</span>
            {!backup.verified ? (
              <label htmlFor={acknowledgeId} className="flex items-start gap-2 text-text-primary">
                <Checkbox
                  id={acknowledgeId}
                  checked={acknowledged}
                  onCheckedChange={(checked) => setAcknowledged(checked === true)}
                />
                <span>I understand no verified recent backup exists and proceed anyway.</span>
              </label>
            ) : null}
          </div>
        ) : null}

        {tierRequiresTypedConfirmation(tier) ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={inputId}>
              Type <span className="font-mono-sm font-semibold">{resourceName}</span> to confirm
            </Label>
            <Input
              id={inputId}
              value={typedName}
              onChange={(event) => setTypedName(event.target.value)}
              autoComplete="off"
              autoFocus
              aria-describedby={impactSummary ? impactId : undefined}
            />
          </div>
        ) : null}

        <AlertDialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'primary'}
            pending={pending}
            disabled={!canConfirm}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
