/* Select2 dropdown: searchable single and multi select. */

"use client";

import { useEffect, useRef } from "react";
import "select2/dist/css/select2.min.css";

export type SelectOption = { value: string; label: string };

/** UI label in Title Case; DB value stays exactly as given. */
export function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function enumOptions(values: readonly string[]): SelectOption[] {
  return values.map((value) => ({ value, label: titleCase(value) }));
}

type JQuerySelect2 = {
  select2: (arg?: unknown) => JQuerySelect2;
  on: (event: string, handler: (e: Event) => void) => void;
  off: (event: string) => void;
  val: (value?: string | string[]) => string | string[] | JQuerySelect2;
  trigger: (event: string) => void;
};

type Props = {
  value: string | string[];
  onChange: (value: never) => void;
  options: SelectOption[];
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  multiple?: boolean;
  className?: string;
};

async function loadSelect2() {
  const jqueryModule = await import("jquery");
  const $ = (jqueryModule.default ?? jqueryModule) as unknown as (
    el: HTMLSelectElement,
  ) => JQuerySelect2 & { fn?: { select2?: unknown } };
  const jq = $ as unknown as { fn?: { select2?: unknown } };
  if (typeof window !== "undefined") {
    const w = window as unknown as Record<string, unknown>;
    if (!w.jQuery) w.jQuery = $;
    if (!w.$) w.$ = $;
  }
  if (typeof jq.fn?.select2 !== "function") {
    const select2Module = await import("select2");
    const factory = (select2Module.default ?? select2Module) as unknown;
    if (typeof factory === "function") {
      (factory as (root: Window, jQuery: unknown) => void)(window, $);
    }
  }
  if (typeof jq.fn?.select2 !== "function") {
    throw new Error("Select2 failed to load.");
  }
  return $;
}

export function Select2({
  value,
  onChange,
  options,
  ariaLabel,
  placeholder,
  disabled,
  multiple = false,
  className,
}: Props) {
  const ref = useRef<HTMLSelectElement>(null);
  const onChangeRef = useRef(onChange);
  const multipleRef = useRef(multiple);

  useEffect(() => {
    onChangeRef.current = onChange;
    multipleRef.current = multiple;
  }, [onChange, multiple]);
  const optionsKey = options.map((o) => `${o.value}:${o.label}`).join("|");
  const valueKey = Array.isArray(value) ? value.join("|") : value;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let destroyed = false;
    let jqEl: JQuerySelect2 | null = null;

    (async () => {
      try {
        const $ = await loadSelect2();
        if (destroyed || !ref.current) return;
        jqEl = $(el) as JQuerySelect2;
        const dialog = el.closest('[role="dialog"]');
        const jqAny = $ as unknown as (target: unknown) => JQuerySelect2;
        jqEl.select2({
          width: "100%",
          minimumResultsForSearch: 0,
          ...(dialog ? { dropdownParent: jqAny(dialog) } : {}),
          ...(placeholder ? { placeholder } : {}),
          allowClear: false,
          closeOnSelect: !multipleRef.current,
          disabled: Boolean(disabled),
        });
        jqEl.on("change.select2-shoptalk", () => {
          if (multipleRef.current) {
            const raw = (jqEl as JQuerySelect2).val() as string[] | string;
            (onChangeRef.current as (v: string[]) => void)(Array.isArray(raw) ? raw : raw ? [raw] : []);
          } else {
            (onChangeRef.current as (v: string) => void)(el.value);
          }
        });
      } catch (err) {
        console.error(err);
      }
    })();

    return () => {
      destroyed = true;
      try {
        jqEl?.off("change.select2-shoptalk");
        jqEl?.select2("destroy");
      } catch {
        // Select2 was never initialised.
      }
    };
  }, [optionsKey, placeholder, disabled, multiple]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    loadSelect2()
      .then(($) => {
        const jqEl = $(el) as JQuerySelect2;
        const current = jqEl.val();
        const same = Array.isArray(value)
          ? Array.isArray(current) && current.join("|") === value.join("|")
          : current === value;
        if (!same) {
          jqEl.val(value);
          jqEl.trigger("change.select2");
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey]);

  return (
    <select
      ref={ref}
      value={value}
      multiple={multiple}
      onChange={(e) => {
        if (multiple) {
          (onChange as (v: string[]) => void)(
            Array.from(e.target.selectedOptions).map((o) => o.value),
          );
        } else {
          (onChange as (v: string) => void)(e.target.value);
        }
      }}
      aria-label={ariaLabel}
      disabled={disabled}
      className={className ?? "st-select2 w-full"}
    >
      {!multiple && placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
