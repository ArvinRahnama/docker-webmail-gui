import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { ConfirmDialog, type ConfirmDialogProps } from './confirm-dialog';

function Harness(props: Partial<ConfirmDialogProps>) {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      tier={1}
      title="Confirm this?"
      description="Are you sure?"
      onConfirm={() => {}}
      {...props}
    />
  );
}

describe('ConfirmDialog — tier 1 (confirm)', () => {
  it('renders the title and description and calls onConfirm on click', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    expect(screen.getByText('Confirm this?')).toBeInTheDocument();
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('always renders a Cancel action alongside Confirm — never the only prominent action (§8)', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('the destructive/confirm button is never the element focus lands on when the dialog opens', () => {
    render(<Harness destructive />);
    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    expect(document.activeElement).not.toBe(confirmButton);
  });

  it('clicking Cancel calls onOpenChange(false)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('disables Confirm while pending', () => {
    render(<Harness pending />);
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });
});

describe('ConfirmDialog — tier 3 (type-to-confirm + impact summary)', () => {
  const tier3Props: Pick<ConfirmDialogProps, 'tier' | 'resourceName' | 'impactSummary'> = {
    tier: 3,
    resourceName: 'user@example.com',
    impactSummary: '1,284 messages, 2.3 GB of mail data will be deleted.',
  };

  it('renders the impact summary and requires typing the exact resource name', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness {...tier3Props} onConfirm={onConfirm} />);

    expect(
      screen.getByText('1,284 messages, 2.3 GB of mail data will be deleted.'),
    ).toBeInTheDocument();

    const confirmButton = screen.getByRole('button', { name: /^Confirm$/ });
    expect(confirmButton).toBeDisabled();

    const input = screen.getByRole('textbox');
    await user.type(input, 'wrong-value');
    expect(confirmButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, 'user@example.com');
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('is case-sensitive — a near-miss does not satisfy the match', async () => {
    const user = userEvent.setup();
    render(<Harness {...tier3Props} />);

    await user.type(screen.getByRole('textbox'), 'User@Example.com');
    expect(screen.getByRole('button', { name: /^Confirm$/ })).toBeDisabled();
  });

  it('resets the typed value when the dialog is closed and reopened', async () => {
    const user = userEvent.setup();

    function ReopenHarness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(true)}>reopen</button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="Delete mailbox"
            description="This cannot be undone."
            onConfirm={() => {}}
            {...tier3Props}
          />
        </>
      );
    }
    render(<ReopenHarness />);

    await user.type(screen.getByRole('textbox'), 'user@example.com');
    expect(screen.getByRole('button', { name: /^Confirm$/ })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByText('reopen'));

    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByRole('button', { name: /^Confirm$/ })).toBeDisabled();
  });

  it('throws if resourceName or impactSummary is missing at tier 3 (a dev-time contract, not a silently-weaker dialog)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Harness tier={3} onConfirm={() => {}} />)).toThrow(
      /resourceName.*impactSummary/i,
    );
    consoleError.mockRestore();
  });
});

describe('ConfirmDialog — tier 4 (type-to-confirm + preflight + backup gate)', () => {
  const tier4Base: Pick<
    ConfirmDialogProps,
    'tier' | 'resourceName' | 'impactSummary' | 'preflight'
  > = {
    tier: 4,
    resourceName: 'nightly-2026-08-14',
    impactSummary: 'Restoring will overwrite all current mail data.',
    preflight: 'Container will be stopped during restore.',
  };

  it('enables Confirm once the resource name is typed when a verified backup exists', async () => {
    const user = userEvent.setup();
    render(
      <Harness {...tier4Base} backup={{ verified: true, description: 'Verified 3 hours ago' }} />,
    );

    expect(screen.getByText('Verified 3 hours ago')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    await user.type(screen.getByRole('textbox'), 'nightly-2026-08-14');
    expect(screen.getByRole('button', { name: /^Confirm$/ })).toBeEnabled();
  });

  it('requires the acknowledgement checkbox, in addition to typing, when no verified backup exists', async () => {
    const user = userEvent.setup();
    render(
      <Harness {...tier4Base} backup={{ verified: false, description: 'No backup on record' }} />,
    );

    await user.type(screen.getByRole('textbox'), 'nightly-2026-08-14');
    expect(screen.getByRole('button', { name: /^Confirm$/ })).toBeDisabled();

    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: /^Confirm$/ })).toBeEnabled();
  });

  it('throws if backup is missing at tier 4', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Harness {...tier4Base} />)).toThrow(/backup/i);
    consoleError.mockRestore();
  });
});
