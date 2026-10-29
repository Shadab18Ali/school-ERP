import { clsx } from "clsx";
import { Check, X } from "lucide-react";
import type { AdmissionStatus } from "@/lib/public-api";

const STEPS = ["Application", "Review", "Verification", "Decision", "Fee payment", "Student created"];
const REACHED: Record<AdmissionStatus, number> = { submitted: 0, under_review: 1, verified: 2, approved: 3, rejected: 3, fee_paid: 4, enrolled: 5 };

/** Application → Review → Verification → Approved/Rejected → Fee payment → Student created */
export function AdmissionStepper({ status, history = [] }: { status: AdmissionStatus; history?: AdmissionStatus[] }) {
  // a rejection can come at any stage: only the steps the application really passed are ticked
  const reached = status === "rejected"
    ? Math.max(0, ...history.filter((h) => h !== "rejected").map((h) => REACHED[h])) : REACHED[status];
  return (
    <ol className="grid grid-cols-3 gap-y-4 sm:grid-cols-6" data-testid="admission-stepper" aria-label="Application progress">
      {STEPS.map((label, i) => {
        const failed = status === "rejected" && i === 3;
        const done = !failed && i <= reached;
        const next = !failed && status !== "rejected" && i === reached + 1;
        const text = i === 3 && status === "rejected" ? "Not approved" : i === 3 && reached >= 3 ? "Approved" : label;
        return (
          <li key={label} className="flex flex-col items-center text-center" aria-current={next ? "step" : undefined} data-state={failed ? "failed" : done ? "done" : next ? "next" : "todo"}>
            <span className={clsx("grid size-8 place-items-center rounded-full border-2 text-xs font-semibold",
              failed ? "border-danger-600 bg-danger-600 text-white" : done ? "border-leaf-600 bg-leaf-600 text-white" : next ? "border-leaf-600 text-leaf-700" : "border-line text-muted")}>
              {failed ? <X className="size-4" /> : done ? <Check className="size-4" /> : i + 1}
            </span>
            <span className={clsx("mt-1.5 text-xs", failed ? "font-semibold text-danger-600" : done ? "font-medium" : "text-muted")}>{text}</span>
          </li>
        );
      })}
    </ol>
  );
}
