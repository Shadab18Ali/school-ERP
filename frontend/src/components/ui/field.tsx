import { clsx } from "clsx";
import { forwardRef, useId, type InputHTMLAttributes, type SelectHTMLAttributes } from "react";

const control =
  "block w-full rounded-md border border-line bg-white px-3 text-sm text-ink placeholder:text-muted/70 focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20 disabled:bg-paper aria-[invalid=true]:border-danger-600";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string | null;
}

export const TextField = forwardRef<HTMLInputElement, FieldProps>(function TextField(
  { label, hint, error, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className={className}>
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
        {rest.required && <span className="text-danger-600"> *</span>}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={clsx(control, "h-10")}
        {...rest}
      />
      {error ? (
        <p id={`${inputId}-error`} className="mt-1 text-xs text-danger-600">{error}</p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="mt-1 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
});

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hideLabel?: boolean;
}

export function SelectField({ label, hideLabel, className, id, children, ...rest }: SelectProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <div className={className}>
      <label htmlFor={selectId} className={clsx("mb-1.5 block text-sm font-medium", hideLabel && "sr-only")}>
        {label}
      </label>
      <select id={selectId} className={clsx(control, "h-10 pr-8")} {...rest}>
        {children}
      </select>
    </div>
  );
}
