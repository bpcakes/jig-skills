import React, { createContext, useContext } from "react";

interface Session {
  userId: string;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("SessionProvider is missing");
  return session;
}

export interface TextInputProps {
  value: string;
  onChange(value: string): void;
  className?: string;
}

export function TextInput({ value, onChange, className }: TextInputProps) {
  return (
    <input
      className={className}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
