import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { DataTable, type DataTableColumn } from './data-table';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly age: number;
}

const ROWS: Row[] = [
  { id: 'a', name: 'Ada', age: 36 },
  { id: 'b', name: 'Bob', age: 24 },
  { id: 'c', name: 'Cy', age: 51 },
];

const COLUMNS: DataTableColumn<Row>[] = [
  { id: 'name', header: 'Name', cell: (row) => row.name, sortValue: (row) => row.name },
  { id: 'age', header: 'Age', cell: (row) => String(row.age), sortValue: (row) => row.age },
];

function renderTable(overrides: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}) {
  return render(
    <DataTable
      data={ROWS}
      columns={COLUMNS}
      getRowId={(row) => row.id}
      caption="People"
      emptyState={<div>Nothing here</div>}
      {...overrides}
    />,
  );
}

describe('DataTable — rendering', () => {
  it('renders one row per data item with the right cell content', () => {
    renderTable();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Cy')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(ROWS.length + 1); // + header row
  });

  it('carries a screen-reader caption naming the table', () => {
    renderTable();
    expect(screen.getByText('People')).toBeInTheDocument();
  });

  it('renders the caller-supplied empty state when data is empty, not a table', () => {
    renderTable({ data: [] });
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders a loading state instead of the table when isLoading is true', () => {
    renderTable({ isLoading: true, data: [] });
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('DataTable — sorting', () => {
  it('sorts ascending then descending on repeated header clicks, updating aria-sort', async () => {
    const user = userEvent.setup();
    renderTable();

    const nameHeader = screen.getByRole('columnheader', { name: /name/i });
    expect(nameHeader).toHaveAttribute('aria-sort', 'none');

    await user.click(within(nameHeader).getByRole('button'));
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
    let cells = screen
      .getAllByRole('cell')
      .filter((c) => ['Ada', 'Bob', 'Cy'].includes(c.textContent ?? ''));
    expect(cells.map((c) => c.textContent)).toEqual(['Ada', 'Bob', 'Cy']);

    await user.click(within(nameHeader).getByRole('button'));
    expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
    cells = screen
      .getAllByRole('cell')
      .filter((c) => ['Ada', 'Bob', 'Cy'].includes(c.textContent ?? ''));
    expect(cells.map((c) => c.textContent)).toEqual(['Cy', 'Bob', 'Ada']);
  });

  it('sorts numerically, not lexically, for a numeric sortValue (9 before 80, unlike string order)', async () => {
    const user = userEvent.setup();
    const numericRows: Row[] = [
      { id: 'x', name: 'X', age: 80 },
      { id: 'y', name: 'Y', age: 9 },
    ];
    renderTable({ data: numericRows });

    const ageHeader = screen.getByRole('columnheader', { name: /age/i });
    await user.click(within(ageHeader).getByRole('button'));

    const rows = screen.getAllByRole('row').slice(1); // drop header row
    const firstRowName = within(rows[0]!).getAllByRole('cell')[0]?.textContent;
    // A lexical ("80" < "9") sort would put 80 first; numeric sorting
    // must put 9 first.
    expect(firstRowName).toBe('Y');
  });

  it('every column sorts ascending on the first click, whatever its value type (never a silent per-column default)', async () => {
    const user = userEvent.setup();
    renderTable();

    const ageHeader = screen.getByRole('columnheader', { name: /age/i });
    await user.click(within(ageHeader).getByRole('button'));
    expect(ageHeader).toHaveAttribute('aria-sort', 'ascending');

    const rows = screen.getAllByRole('row').slice(1);
    const firstRowName = within(rows[0]!).getAllByRole('cell')[0]?.textContent;
    expect(firstRowName).toBe('Bob'); // age 24, the smallest
  });

  // TanStack Table v9 requires named sort functions to be registered
  // explicitly (unlike v8, where 'alphanumeric'/'text' were built in) — see
  // data-table.tsx's `features` doc comment. Leaving one unregistered
  // doesn't disable sorting; a header click still reorders rows, just with
  // table-core's raw `sortFn_basic` (`>`) fallback silently swapped in
  // instead of the intended one. Both tests below fail without that
  // registration — case-insensitivity and natural-numeric order are
  // exactly what a raw comparison gets wrong, and exactly what the
  // suite's other sort tests (plain, same-case, digit-free names) never
  // happened to exercise.
  it('sorts a text column case-insensitively, not by raw character code', async () => {
    const user = userEvent.setup();
    const rows: Row[] = [
      { id: 'x', name: 'Banana', age: 1 },
      { id: 'y', name: 'apple', age: 2 },
    ];
    renderTable({ data: rows });

    const nameHeader = screen.getByRole('columnheader', { name: /name/i });
    await user.click(within(nameHeader).getByRole('button'));

    const rowEls = screen.getAllByRole('row').slice(1);
    const firstCell = within(rowEls[0]!).getAllByRole('cell')[0]?.textContent;
    // Case-insensitive alphabetical: "apple" before "Banana". A raw
    // character-code comparison would put "Banana" first instead — every
    // uppercase letter sorts before every lowercase one in UTF-16.
    expect(firstCell).toBe('apple');
  });

  it('sorts a mixed alphanumeric column naturally, not lexically (item2 before item10)', async () => {
    const user = userEvent.setup();
    const rows: Row[] = [
      { id: 'x', name: 'item10', age: 1 },
      { id: 'y', name: 'item2', age: 2 },
    ];
    renderTable({ data: rows });

    const nameHeader = screen.getByRole('columnheader', { name: /name/i });
    await user.click(within(nameHeader).getByRole('button'));

    const rowEls = screen.getAllByRole('row').slice(1);
    const firstCell = within(rowEls[0]!).getAllByRole('cell')[0]?.textContent;
    // Natural sort: "item2" before "item10" (2 < 10 as numbers). A lexical
    // comparison ("1" < "2" as characters) would put "item10" first.
    expect(firstCell).toBe('item2');
  });

  it('a column with no sortValue renders no sort button and no aria-sort', () => {
    const columns: DataTableColumn<Row>[] = [
      { id: 'name', header: 'Name', cell: (row) => row.name },
    ];
    renderTable({ columns });
    const header = screen.getByRole('columnheader', { name: /name/i });
    expect(header).not.toHaveAttribute('aria-sort');
    expect(within(header).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('DataTable — pagination', () => {
  it('paginates and reports the correct page count', async () => {
    const user = userEvent.setup();
    renderTable({ pageSize: 2 });

    expect(screen.getByText(/page 1 of 2/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous page/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next page/i })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(screen.getByText(/page 2 of 2/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next page/i })).toBeDisabled();
  });
});

describe('DataTable — selection', () => {
  function ControlledSelectionTable() {
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    return (
      <>
        <DataTable
          data={ROWS}
          columns={COLUMNS}
          getRowId={(row) => row.id}
          caption="People"
          emptyState={<div>Nothing here</div>}
          selectedIds={selected}
          onSelectedIdsChange={setSelected}
        />
        <output data-testid="selected-count">{selected.size}</output>
      </>
    );
  }

  it('toggling a row checkbox updates the caller-owned selection', async () => {
    const user = userEvent.setup();
    render(<ControlledSelectionTable />);

    const checkboxes = screen.getAllByRole('checkbox');
    // First checkbox is "select all"; row checkboxes follow.
    await user.click(checkboxes[1]!);

    expect(screen.getByTestId('selected-count')).toHaveTextContent('1');
  });

  it('the "select all on page" checkbox selects every visible row', async () => {
    const user = userEvent.setup();
    render(<ControlledSelectionTable />);

    await user.click(screen.getAllByRole('checkbox')[0]!);

    expect(screen.getByTestId('selected-count')).toHaveTextContent(String(ROWS.length));
  });

  it('does not render selection checkboxes when selectedIds/onSelectedIdsChange are omitted', () => {
    renderTable();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

describe('DataTable — row actions', () => {
  it('renders caller-supplied row actions per row', () => {
    renderTable({ rowActions: (row) => <button>Delete {row.name}</button> });
    expect(screen.getByRole('button', { name: 'Delete Ada' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Bob' })).toBeInTheDocument();
  });
});

describe('DataTable — stable columns prop', () => {
  it('does not throw when re-rendered with a fresh columns array reference each time (common caller pattern)', () => {
    const onRerender = vi.fn();
    function Wrapper({ n }: { n: number }) {
      onRerender();
      return (
        <DataTable
          data={ROWS}
          columns={[
            { id: 'name', header: 'Name', cell: (row) => row.name, sortValue: (row) => row.name },
          ]}
          getRowId={(row) => row.id}
          caption={`People ${n}`}
          emptyState={<div>Nothing here</div>}
        />
      );
    }
    const { rerender } = render(<Wrapper n={1} />);
    expect(() => rerender(<Wrapper n={2} />)).not.toThrow();
    expect(onRerender).toHaveBeenCalledTimes(2);
  });
});
