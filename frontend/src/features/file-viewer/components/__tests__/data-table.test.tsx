import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable } from '../data-table';
import type { ColumnInfo } from '../../api';

const columns: ColumnInfo[] = [
  { name: 'id', column_type: 'INT64', kind: 'integer', logical_type: null, physical_type: 'INT64' },
  { name: 'tags', column_type: 'LIST', kind: 'nested', logical_type: 'LIST', physical_type: 'GROUP' },
];

function renderTable(props: Partial<React.ComponentProps<typeof DataTable>> = {}) {
  const scrollerRef = createRef<HTMLDivElement>();
  return render(
    <DataTable
      columns={columns}
      rows={[{ id: 1, tags: '[1]' }]}
      selectedRow={null}
      onSelectRow={vi.fn()}
      searchTerm=""
      searchMatches={[]}
      currentMatchIndex={0}
      typeDisplay="logical"
      density="comfortable"
      scrollerRef={scrollerRef}
      {...props}
    />
  );
}

describe('DataTable sort headers', () => {
  it('offers a sort button on sortable columns only, and reports the click', async () => {
    const onSort = vi.fn();
    renderTable({ onSort });

    const buttons = screen.getAllByTitle('viewer.sort.toggle');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent('id');
    // The nested column's name is plain text.
    expect(screen.getByText('tags').closest('button')).toBeNull();

    await userEvent.setup().click(buttons[0]);
    expect(onSort).toHaveBeenCalledWith('id');
  });

  it('marks the sorted column with its direction', () => {
    const { rerender, container } = renderTable({ onSort: vi.fn(), sort: { column: 'id', direction: 'asc' } });
    const header = () => container.querySelector('th[title="id"]')!;
    expect(header()).toHaveAttribute('aria-sort', 'ascending');

    rerender(
      <DataTable
        columns={columns}
        rows={[]}
        selectedRow={null}
        onSelectRow={vi.fn()}
        searchTerm=""
        searchMatches={[]}
        currentMatchIndex={0}
        typeDisplay="logical"
        density="comfortable"
        scrollerRef={createRef<HTMLDivElement>()}
        onSort={vi.fn()}
        sort={{ column: 'id', direction: 'desc' }}
      />
    );
    expect(header()).toHaveAttribute('aria-sort', 'descending');
  });

  it('renders plain names without a sort handler', () => {
    renderTable();
    expect(screen.queryByTitle('viewer.sort.toggle')).toBeNull();
    expect(screen.getByText('id')).toBeInTheDocument();
  });
});

describe('DataTable cell tooltips', () => {
  it('titles the cells that do not fit their column and leaves the rest bare', () => {
    const { container } = renderTable({
      columns: [
        { name: 'id', column_type: 'INT64', kind: 'integer', logical_type: null, physical_type: 'INT64' },
        { name: 'note', column_type: 'BYTE_ARRAY', kind: 'text', logical_type: 'String', physical_type: 'BYTE_ARRAY' },
      ],
      rows: [{ id: 1, note: 'x'.repeat(500) }],
    });

    const cells = container.querySelectorAll('tbody td');
    expect(cells[0]).not.toHaveAttribute('title');
    expect(cells[1]).toHaveAttribute('title', 'x'.repeat(500));
  });
});
