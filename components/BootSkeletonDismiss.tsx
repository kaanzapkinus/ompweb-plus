"use client";

import { useEffect } from "react";

export function BootSkeletonDismiss() {
  useEffect(() => {
    document.getElementById("boot-skeleton")?.remove();
  }, []);

  return null;
}
