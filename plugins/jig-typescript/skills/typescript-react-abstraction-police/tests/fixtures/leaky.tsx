import React, {
  Children,
  Dispatch,
  SetStateAction,
  cloneElement,
  createContext,
  useImperativeHandle,
} from "react";
import type { Control } from "react-hook-form";
import {
  useQuery,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  Dialog as VendorDialog,
  type DialogProps as VendorDialogProps,
} from "vendor-ui";
import { cache } from "../internal/cache";

interface User {
  id: string;
}

export const UserContext = createContext<User | null>(null);

export interface UserPanelProps {
  showHeader?: boolean;
  showAvatar?: boolean;
  compact?: boolean;
  isEditing?: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  setMode(mode: string): void;
  rootClassName?: string;
  headerClassName?: string;
  avatarClassName?: string;
  control: Control<Record<string, unknown>>;
  queryKey?: QueryKey;
  staleTime?: number;
  unsafeBypassCache?: boolean;
  rawResponse?: boolean;
}

export function useUser(): UseQueryResult<User> {
  return useQuery({ queryKey: ["user"], queryFn: async () => ({ id: "1" }) });
}

export function ChildContract({ child }: { child: React.ReactElement }) {
  const only = Children.only(child);
  return cloneElement(only, { role: "presentation" });
}

export interface WidgetHandle {
  sync(): void;
  flush(): void;
  recalculate(): void;
  resetCache(): void;
}

export function Widget() {
  useImperativeHandle({ current: null }, () => ({
    sync() {},
    flush() {},
    recalculate() {},
    resetCache() {},
  }));
  return <div>{String(cache)}</div>;
}

export function Dialog(props: VendorDialogProps) {
  return <VendorDialog {...props} />;
}
