import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UnsupportedNotice } from './unsupported-notice';

const REASON = 'This volume backs mail data and can never be removed.';

function renderTooltipNotice() {
  render(
    <UnsupportedNotice variant="tooltip" reason={REASON}>
      <button type="button" disabled>
        Remove
      </button>
    </UnsupportedNotice>,
  );
  return screen.getByRole('button', { name: 'Remove' }).parentElement!;
}

function tap(element: HTMLElement) {
  fireEvent.pointerDown(element, { pointerType: 'touch' });
  fireEvent.pointerUp(element, { pointerType: 'touch' });
  fireEvent.click(element);
}

describe('UnsupportedNotice (tooltip variant)', () => {
  it('shows the explanation on a touch tap, which Radix Tooltip alone ignores', () => {
    const trigger = renderTooltipNotice();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    tap(trigger);
    expect(screen.getByRole('tooltip')).toHaveTextContent(REASON);
  });

  it('toggles closed on a second tap', () => {
    const trigger = renderTooltipNotice();
    tap(trigger);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    tap(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('keeps keyboard focus opening it', () => {
    const trigger = renderTooltipNotice();
    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toHaveTextContent(REASON);
  });

  it('does not open on a mouse click', () => {
    const trigger = renderTooltipNotice();
    fireEvent.pointerDown(trigger, { pointerType: 'mouse' });
    fireEvent.click(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
