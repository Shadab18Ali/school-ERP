import { clsx } from "clsx";

const SIZES = { sm: "size-9 text-xs", md: "size-12 text-sm", lg: "size-24 text-2xl" };

export function StudentAvatar({ name, url, size = "sm" }: { name: string; url: string | null; size?: keyof typeof SIZES }) {
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return (
    <span className={clsx("grid shrink-0 place-items-center overflow-hidden rounded-full bg-leaf-50 font-semibold text-leaf-700", SIZES[size])}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={`Photo of ${name}`} className="size-full object-cover" data-testid="student-photo" />
      ) : (
        <span aria-hidden>{initials}</span>
      )}
    </span>
  );
}
