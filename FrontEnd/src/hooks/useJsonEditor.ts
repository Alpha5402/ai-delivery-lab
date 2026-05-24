import { useEffect, useMemo, useState } from "react";
import { formatJson, parseJson } from "../lib/jsonValidation";

export function useJsonEditor(value: unknown) {
  const [draft, setDraft] = useState(() => formatJson(value ?? {}));

  useEffect(() => {
    setDraft(formatJson(value ?? {}));
  }, [value]);

  const parsed = useMemo(() => parseJson(draft), [draft]);

  return {
    draft,
    setDraft,
    parsed,
    format() {
      if (parsed.ok) {
        setDraft(formatJson(parsed.value));
      }
    },
  };
}
