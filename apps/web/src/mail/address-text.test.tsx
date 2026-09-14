import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { AddressText, addressFloorClassName } from './address-text';

/** The rendered text with a `|` wherever a `<wbr>` allows a line break. */
function breakPoints(text: string): { readonly marked: string; readonly root: HTMLElement } {
  const { container } = render(
    <div>
      <AddressText text={text} />
    </div>,
  );
  const root = container.firstElementChild as HTMLElement;
  const clone = root.cloneNode(true) as HTMLElement;
  for (const wbr of clone.querySelectorAll('wbr')) wbr.replaceWith('|');
  return { marked: clone.textContent ?? '', root };
}

describe('AddressText', () => {
  it('leaves a short address whole, with no break points', () => {
    expect(breakPoints('user1@example.com').marked).toBe('user1@example.com');
  });

  it('breaks a long address only at label boundaries, keeping a short final label attached', () => {
    const { marked, root } = breakPoints('accounts.payable@northwind-traders.com');
    expect(marked).toBe('accounts.|payable@|northwind-|traders.com');
    expect(root.textContent).toBe('accounts.payable@northwind-traders.com');
    expect(root.querySelector('.wrap-anywhere')).toBeNull();
  });

  it('breaks before a final label longer than three letters', () => {
    expect(breakPoints('longorganisationdomain.example').marked).toBe(
      'longorganisationdomain.|example',
    );
  });

  it('lets only an over-long label split anywhere, not the ordinary labels around it', () => {
    const local = 'averyveryverylongmailboxlocalpartwithoutanyhyphensatall012345678';
    const { marked, root } = breakPoints(`${local}@longorganisationdomain.example`);
    expect(marked).toBe(`${local}@|longorganisationdomain.|example`);
    const anywhere = root.querySelectorAll('.wrap-anywhere');
    expect([...anywhere].map((el) => el.textContent)).toEqual([`${local}@`]);
  });
});

describe('addressFloorClassName', () => {
  it('floors long addresses and over-long labels, but not short values or ordinary domains', () => {
    expect(addressFloorClassName('user1@example.com')).toBeUndefined();
    expect(addressFloorClassName('notifications.subdomain.example.co.uk')).toBeUndefined();
    expect(addressFloorClassName('accounts.payable@northwind-traders.com')).toBeDefined();
    expect(addressFloorClassName(`${'a'.repeat(30)}.example`)).toBeDefined();
  });
});
