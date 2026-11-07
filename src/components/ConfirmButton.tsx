"use client";

import type { ButtonHTMLAttributes } from "react";

/** A submit button that asks with the browser's own confirm() first (SPEC.md 7.6). */
export function ConfirmButton({
  message,
  ...props
}: { message: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      type="submit"
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    />
  );
}
