import * as React from "react";

export interface DepositOptionsProps {
  onPayWithCard: () => void;
  onPayWithNaira: () => void;
  onSendCrypto: () => void;
  isNigerianUser?: boolean;
}

const COPY = {
  heading: "Add Funds",
  card: "PAY WITH CARD",
  naira: "PAY WITH NAIRA",
  crypto: "SEND CRYPTO",
};

export function DepositOptions({ 
  onPayWithCard, 
  onPayWithNaira, 
  onSendCrypto, 
  isNigerianUser = false 
}: DepositOptionsProps) {
  return (
    <div className="w-full">
      <h3 className="mako-title text-xl mb-4">{COPY.heading}</h3>
      <div className="flex flex-col gap-3">
        <button 
          onClick={onPayWithCard}
          className="w-full mako-button mako-button--signal justify-start text-left"
        >
          {COPY.card}
        </button>

        {isNigerianUser && (
          <button 
            onClick={onPayWithNaira}
            className="w-full mako-button mako-button--signal justify-start text-left"
          >
            {COPY.naira}
          </button>
        )}

        <button 
          onClick={onSendCrypto}
          className="w-full mako-button justify-start text-left bg-paper"
        >
          {COPY.crypto}
        </button>
      </div>
    </div>
  );
}
