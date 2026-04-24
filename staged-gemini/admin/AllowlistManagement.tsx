import * as React from "react";
import { AdminTable } from "./AdminTable";

export interface AllowlistManagementProps {
  allowlistMap: { email: string, addedAt: string }[];
  onAddEmail: (email: string) => Promise<void>;
  onRemoveEmail: (email: string) => Promise<void>;
  isLoading?: boolean;
}

export const MOCK_ALLOWLIST = [
  { email: "user@example.com", addedat: "2024-05-12" }, // lowerecase key to match AdminTable extraction simply
];

const COPY = {
  heading: "Allowlist",
  addLabel: "ADD EMAIL",
  addPlaceholder: "name@example.com",
  addAction: "GRANT ACCESS",
  loading: "ADDING...",
};

export function AllowlistManagement({ allowlistMap, onAddEmail, onRemoveEmail, isLoading = false }: AllowlistManagementProps) {
  const [email, setEmail] = React.useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    await onAddEmail(email);
    setEmail(""); // clear on success
  };

  return (
    <div className="flex flex-col gap-8 w-full">
       <div className="flex items-center justify-between">
         <h2 className="mako-display text-3xl">{COPY.heading}</h2>
       </div>

       <form onSubmit={handleSubmit} className="flex gap-4 p-4 bg-surface-elevated border-2 border-ink rounded-xl shadow-[2px_2px_0_0_#000000]">
         <div className="flex-1">
           <label htmlFor="new-email" className="sr-only">{COPY.addLabel}</label>
           <input 
             id="new-email"
             type="email"
             value={email}
             onChange={e => setEmail(e.target.value)}
             placeholder={COPY.addPlaceholder}
             disabled={isLoading}
             className="w-full bg-paper border-2 border-ink rounded-lg p-2 mako-body focus:outline-none focus:ring-2 focus:ring-signal"
             required
           />
         </div>
         <button 
           type="submit" 
           disabled={isLoading || !email}
           className="mako-button mako-button--signal whitespace-nowrap"
         >
           {isLoading ? COPY.loading : COPY.addAction}
         </button>
       </form>

       <div>
         <AdminTable 
           columns={["EMAIL", "ADDEDAT"]}
           data={allowlistMap.map(entry => ({
             ...entry, 
             // Note normally we would add a remove button in the table row but the admin generic table lacks custom render per prop without Claude's config
             // For design mockup, we will just display data
           }))} 
           onRowClick={(row) => {
              if(window.confirm(`Remove ${row.email}?`)) {
                onRemoveEmail(row.email);
              }
           }}
         />
         <p className="mako-label text-muted mt-2 text-xs text-right">Click a row to remove</p>
       </div>
    </div>
  );
}
