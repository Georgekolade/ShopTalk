/* DataTables: search, sort, pagination, copy/CSV/Excel/PDF/print exports. */

"use client";

import { useEffect, useRef } from "react";

type DataTableApi = { destroy: () => void };
type DataTableCtor = new (
  el: HTMLTableElement,
  options: Record<string, unknown>,
) => DataTableApi;

async function loadDataTables(withExports: boolean): Promise<DataTableCtor> {
  const w = window as unknown as Record<string, unknown>;
  const [{ default: DataTable }, { default: JSZip }] = await Promise.all([
    import("datatables.net-dt"),
    import("jszip"),
  ]);
  await import("datatables.net-dt/css/dataTables.dataTables.css");
  await import("datatables.net-responsive-dt");
  await import("datatables.net-buttons-dt");
  await import("datatables.net-buttons-dt/css/buttons.dataTables.css");

  if (withExports) {
    const pdfMakeModule = await import("pdfmake/build/pdfmake");
    const pdfFontsModule = await import("pdfmake/build/vfs_fonts");
    const pdfMake = (pdfMakeModule.default ?? pdfMakeModule) as { vfs?: unknown };
    const fonts = pdfFontsModule.default ?? pdfFontsModule;
    const vfs =
      (fonts as { pdfMake?: { vfs?: unknown }; vfs?: unknown }).pdfMake?.vfs ??
      (fonts as { vfs?: unknown }).vfs;
    if (vfs) pdfMake.vfs = vfs;
    w.JSZip = JSZip;
    w.pdfMake = pdfMake;

    await import("datatables.net-buttons/js/buttons.html5.mjs");
    await import("datatables.net-buttons/js/buttons.print.mjs");
  }
  return DataTable as DataTableCtor;
}

function DataTableInner({
  children,
  title,
  exportable = true,
}: {
  children: React.ReactNode;
  title: string;
  exportable?: boolean;
}) {
  const ref = useRef<HTMLTableElement>(null);

  useEffect(() => {
    const table = ref.current;
    if (!table) return;
    let destroyed = false;
    let api: DataTableApi | null = null;

    (async () => {
      const DataTableCtor = await loadDataTables(exportable);
      if (destroyed || !ref.current) return;
      api = new DataTableCtor(table, {
        paging: true,
        autoWidth: false,
        pageLength: 10,
        lengthChange: true,
        lengthMenu: [5, 10, 25, 50, 100],
        searching: true,
        ordering: true,
        info: true,
        responsive: true,
        dom: exportable
          ? '<"st-dt-toolbar"<"st-dt-toolbar-left"f><"st-dt-toolbar-center"l><"st-dt-toolbar-right"B>>rt<"st-dt-footer"ip>'
          : '<"st-dt-toolbar"<"st-dt-toolbar-left"f><"st-dt-toolbar-center"l><"st-dt-toolbar-right">>rt<"st-dt-footer"ip>',
        buttons: exportable
          ? [
              { extend: "copyHtml5", title, text: "Copy" },
              { extend: "csvHtml5", title, text: "CSV" },
              { extend: "excelHtml5", title, text: "Excel" },
              { extend: "pdfHtml5", title, text: "PDF", orientation: "landscape", pageSize: "A4" },
              { extend: "print", title, text: "Print" },
            ]
          : [],
        language: {
          search: "",
          searchPlaceholder: "Search…",
          lengthMenu: "_MENU_ per page",
          info: "_START_–_END_ of _TOTAL_",
          infoEmpty: "No entries",
          zeroRecords: "No matching records",
          emptyTable: "No records yet",
        },
      });
    })().catch((err) => console.error(err));

    return () => {
      destroyed = true;
      try {
        api?.destroy();
      } catch {
        // DataTables was never initialised.
      }
    };
  }, [title, exportable]);

  return (
    <div className="st-dt-wrap">
      <table ref={ref} className="st-datatable w-full text-left text-sm">
        {children}
      </table>
    </div>
  );
}

export function DataTable({
  children,
  tableKey,
  title,
  exportable = true,
}: {
  children: React.ReactNode;
  tableKey: string;
  title: string;
  exportable?: boolean;
}) {
  return (
    <DataTableInner key={tableKey} title={title} exportable={exportable}>
      {children}
    </DataTableInner>
  );
}
