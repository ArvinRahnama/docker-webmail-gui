import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BreakableText } from './breakable-text';

describe('BreakableText', () => {
  it('adds a break opportunity after each separator without changing the text', () => {
    const { container } = render(
      <span>
        <BreakableText text="post.master@mail.example.com" />
      </span>,
    );
    expect(container.textContent).toBe('post.master@mail.example.com');
    expect(container.querySelectorAll('wbr')).toHaveLength(4);
  });

  it('renders plain text when there is nothing to break after', () => {
    const { container } = render(
      <span>
        <BreakableText text="localhost" />
      </span>,
    );
    expect(container.innerHTML).toBe('<span>localhost</span>');
  });

  it('never adds a break after a trailing separator', () => {
    const { container } = render(
      <span>
        <BreakableText text="example.com." />
      </span>,
    );
    expect(container.querySelectorAll('wbr')).toHaveLength(1);
  });
});
