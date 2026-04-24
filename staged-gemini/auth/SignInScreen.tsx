import * as React from "react";
// import { Logo } from "../../mako market design file/components/Logo";

export interface SignInScreenProps {
  onSignInEmail: (email: string) => Promise<void>;
  onConnectWallet: () => void;
  isLoading?: boolean;
}

const COPY = {
  heading: "Sign in to Mako",
  emailPlaceholder: "name@example.com",
  submit: "SIGN IN WITH EMAIL",
  loading: "SENDING LINK...",
  walletConnectText: "I'm a crypto user",
  walletConnectLink: "Connect Wallet",
};

export function SignInScreen({ onSignInEmail, onConnectWallet, isLoading = false }: SignInScreenProps) {
  const [email, setEmail] = React.useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (email && !isLoading) {
      onSignInEmail(email);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center w-full max-w-sm mx-auto px-4">
      {/* Big Mako Lockup */}
      <div className="mb-12">
        {/* <Logo variant="lockup" size={80} /> */}
        <div className="font-display font-black text-6xl tracking-tighter text-ink text-center">
          MAKO
        </div>
      </div>

      <form onSubmit={handleSubmit} className="w-full flex flex-col gap-4 relative z-10">
        <label className="sr-only" htmlFor="email">Email address</label>
        <input 
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={COPY.emailPlaceholder}
          disabled={isLoading}
          className="w-full bg-paper border-2 border-ink rounded-xl px-4 py-3 mako-body text-ink placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-signal focus:border-ink shadow-[2px_2px_0_0_#000000] disabled:opacity-50"
          required
        />
        
        <button 
          type="submit"
          disabled={isLoading || !email}
          className="w-full mako-button mako-button--signal disabled:opacity-75 disabled:cursor-not-allowed"
        >
          {isLoading ? COPY.loading : COPY.submit}
        </button>
      </form>

      {/* Tiny hidden-ish footer link for crypto users */}
      <div className="mt-12 text-center">
        <p className="mako-label text-[10px] text-muted">
          {COPY.walletConnectText}{" "}
          <button 
            onClick={onConnectWallet}
            className="text-ink underline underline-offset-2 hover:bg-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:bg-signal"
            type="button"
          >
            &rarr; {COPY.walletConnectLink}
          </button>
        </p>
      </div>
    </div>
  );
}
