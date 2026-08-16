import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HealthIndicator } from './health-indicator';
import { STATUS_STATES } from './status';

describe('HealthIndicator', () => {
  it.each(STATUS_STATES)('renders the %s state word as real text by default', (status) => {
    render(<HealthIndicator status={status} />);
    const text = screen.getByText(new RegExp(status, 'i'));
    expect(text).toBeInTheDocument();
    expect(text).not.toHaveClass('sr-only');
  });

  it('keeps the state word in the accessible name even when visually hidden (showLabel=false)', () => {
    render(<HealthIndicator status="critical" showLabel={false} />);
    const text = screen.getByText('Critical');
    expect(text).toHaveClass('sr-only');
  });

  it('accepts a custom label while keeping the icon for the underlying state', () => {
    render(<HealthIndicator status="healthy" label="All systems healthy" />);
    expect(screen.getByText('All systems healthy')).toBeInTheDocument();
  });

  it('spins the pending icon and nothing else', () => {
    const { container: pending } = render(<HealthIndicator status="pending" />);
    const { container: healthy } = render(<HealthIndicator status="healthy" />);
    expect(pending.querySelector('svg')).toHaveClass('animate-spin');
    expect(healthy.querySelector('svg')).not.toHaveClass('animate-spin');
  });
});
