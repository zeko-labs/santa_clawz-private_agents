interface PrivacyStripeProps {
  items: string[];
}

export function PrivacyStripe({ items }: PrivacyStripeProps) {
  return (
    <section className="panel accent-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Turn Preview</p>
          <h2>Privacy Stripe</h2>
        </div>
        <span className="subtle-pill">Legible before execution</span>
      </div>

      <div className="stripe-list">
        {items.map((item) => (
          <span key={item} className="stripe-pill">
            {item}
          </span>
        ))}
      </div>

      <p className="panel-copy">
        Show exactly who can see what, whether the operator is blind, whether a provider is in the
        path, and whether artifacts will disappear after the turn settles.
      </p>
    </section>
  );
}
