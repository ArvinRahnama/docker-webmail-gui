import { useId, useState } from 'react';
import { Eye, EyeOff, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/cn';
import { estimatePasswordStrength, generatePassword } from './password-strength';

/**
 * A password input with generation, a strength meter, and a show/hide
 * toggle (FEATURE_MATRIX.md §6). Fully controlled (`value`/`onChange`) —
 * deliberately not `localStorage`/`sessionStorage`-backed and never
 * calls `console.log`/reports the value anywhere; it is exactly as
 * ephemeral as the React state the caller's form holds it in, which is
 * cleared the moment the form unmounts.
 */
export interface PasswordFieldProps {
  readonly id?: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: 'new-password' | 'current-password';
  readonly error?: string;
  /** Hides the generate button — e.g. for a "current password" field, where generating makes no sense. */
  readonly allowGenerate?: boolean;
  readonly showStrength?: boolean;
  readonly autoFocus?: boolean;
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  error,
  allowGenerate = true,
  showStrength = true,
  autoFocus = false,
}: PasswordFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;
  const strengthId = `${fieldId}-strength`;
  const [visible, setVisible] = useState(false);

  const strength = estimatePasswordStrength(value);

  function handleGenerate() {
    const generated = generatePassword();
    onChange(generated);
    setVisible(true);
    toast.success(
      'Password generated. Copy it now — it is never shown again after you leave this form.',
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={fieldId}>{label}</Label>
        {allowGenerate ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={handleGenerate}
            className="h-auto p-0"
          >
            <RefreshCw className="size-3" aria-hidden="true" />
            Generate
          </Button>
        ) : null}
      </div>

      <div className="relative">
        <Input
          id={fieldId}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={cn(error && errorId, showStrength && strengthId).trim() || undefined}
          className="pr-9"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-text-muted transition-colors duration-fast hover:text-text-primary"
          aria-label={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? (
            <EyeOff className="size-4" aria-hidden="true" />
          ) : (
            <Eye className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>

      {error ? (
        <p id={errorId} role="alert" className="text-caption text-status-critical-fg">
          {error}
        </p>
      ) : null}

      {showStrength && value.length > 0 ? (
        <div id={strengthId} className="flex flex-col gap-1">
          <div className="flex gap-1" aria-hidden="true">
            {[0, 1, 2, 3].map((segment) => (
              <span
                key={segment}
                className={cn(
                  'h-1 flex-1 rounded-full',
                  segment < strength.score
                    ? strengthColorClass(strength.score)
                    : 'bg-border-subtle',
                )}
              />
            ))}
          </div>
          <span className="text-caption text-text-muted">Strength: {strength.label}</span>
        </div>
      ) : null}
    </div>
  );
}

function strengthColorClass(score: number): string {
  if (score >= 4) return 'bg-status-healthy-fg';
  if (score >= 3) return 'bg-status-info-fg';
  if (score >= 2) return 'bg-status-warning-fg';
  return 'bg-status-critical-fg';
}
