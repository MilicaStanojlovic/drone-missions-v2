import { Head, Html } from "@react-email/components";
import type { CSSProperties, ReactNode } from "react";

/**
 * Shared shell for every transactional email, ported 1:1 from the five
 * Thymeleaf templates under the backend's `src/main/resources/templates/email/`.
 *
 * All five templates were byte-for-byte identical outside their accent colour,
 * eyebrow, headline, body copy, CTA and footer line — same `<head>`, same
 * Google-Fonts link, same outer page table, same 560px card, same dark brand
 * bar, same 4px accent stripe, same content cell padding, same footer cell.
 * That common frame lives here; the per-template files supply only the parts
 * that actually differed.
 *
 * Markup fidelity notes (deliberate, small deviations forced by React Email):
 *  - `<Html>` emits the XHTML-transitional doctype and `dir="ltr"` that email
 *    clients expect, where Thymeleaf emitted `<!DOCTYPE html>` and no `dir`.
 *  - `<Head>` emits `<meta http-equiv="Content-Type" … charset=UTF-8>` plus
 *    `<meta name="x-apple-disable-message-reformatting">` instead of the
 *    source's `<meta charset="UTF-8">` — equivalent charset declaration.
 *  - Everything below `<body>` is hand-written table markup rather than
 *    `<Body>`/`<Section>`/`<Row>`/`<Column>`, because those primitives wrap
 *    their children in extra `<table>` layers and the task is a 1:1 port of
 *    the source's table structure.
 *  - HTML entities in the source (`&#9672;`, `&mdash;`, `&rarr;`, `&ldquo;`,
 *    `&#127881;`, `&nbsp;`) are carried over as the literal UTF-8 characters
 *    they denote; the documents declare UTF-8, so this is the same output.
 *
 * SOURCE: drone-missions-backend/drone-missions/src/main/resources/templates/email/*.html
 */

/** Font stacks used by the templates (loaded via the Google Fonts `<link>` below). */
export const emailFonts = {
  /** Body/UI face — `font-family` on `<body>` in every template. */
  sans: "'Space Grotesk','Segoe UI',Arial,sans-serif",
  /** Accent face — brand mark, eyebrow, metric labels and amounts. */
  mono: "'IBM Plex Mono',monospace",
} as const;

/**
 * The palette literally used by the five templates. Same hexes as the design
 * canvas (`design/DroneMissions.dc.html`); named here so the per-template
 * files reference a token rather than repeating raw hexes.
 */
export const emailColors = {
  /** Page background behind the card. */
  pageBackground: "#f4f7fa",
  cardBackground: "#ffffff",
  cardBorder: "#e8edf2",
  /** Dark bar carrying the brand mark. */
  brandBar: "#141e28",
  /** Headline colour (same hex as the brand bar). */
  heading: "#141e28",
  /** `<body>` base text colour. */
  text: "#1b2732",
  /** Lead-paragraph colour. */
  bodyText: "#43525f",
  /** Footer fine-print colour. */
  footerText: "#93a1b0",
  /** Accents, one per template: blue / green / red / amber / grey. */
  primary: "#2f6bff",
  success: "#12a06a",
  danger: "#e04a3f",
  warning: "#d9860a",
  neutral: "#93a1b0",
} as const;

/** The exact stylesheet link every template carries in its `<head>`. */
const GOOGLE_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap";

const bodyStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  background: emailColors.pageBackground,
  fontFamily: emailFonts.sans,
  color: emailColors.text,
};

const pageTableStyle: CSSProperties = {
  background: emailColors.pageBackground,
  padding: "28px 12px",
};

const cardStyle: CSSProperties = {
  maxWidth: "560px",
  width: "100%",
  background: emailColors.cardBackground,
  border: `1px solid ${emailColors.cardBorder}`,
  borderRadius: "14px",
  overflow: "hidden",
};

const brandBarCellStyle: CSSProperties = {
  background: emailColors.brandBar,
  padding: "20px 28px",
};

const brandMarkStyle: CSSProperties = {
  fontFamily: emailFonts.mono,
  fontSize: "15px",
  fontWeight: 600,
  letterSpacing: "0.14em",
  color: "#ffffff",
};

const contentCellStyle: CSSProperties = { padding: "30px 28px 6px" };

const eyebrowStyle: CSSProperties = {
  fontFamily: emailFonts.mono,
  fontSize: "11px",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
};

const headingStyle: CSSProperties = {
  margin: "8px 0 6px",
  fontSize: "22px",
  fontWeight: 700,
  color: emailColors.heading,
};

const footerCellStyle: CSSProperties = { padding: "24px 28px" };

const footerTextStyle: CSSProperties = {
  margin: 0,
  fontSize: "12px",
  lineHeight: 1.5,
  color: emailColors.footerText,
};

const paragraphStyle: CSSProperties = {
  margin: "0 0 18px",
  fontSize: "15px",
  lineHeight: 1.6,
  color: emailColors.bodyText,
};

const buttonStyle: CSSProperties = {
  display: "inline-block",
  color: "#ffffff",
  textDecoration: "none",
  fontSize: "14px",
  fontWeight: 600,
  padding: "12px 22px",
  borderRadius: "9px",
};

const amountBoxStyle: CSSProperties = {
  borderRadius: "10px",
  marginBottom: "22px",
};

const amountBoxCellStyle: CSSProperties = { padding: "14px 16px" };

const amountLabelStyle: CSSProperties = {
  fontFamily: emailFonts.mono,
  fontSize: "9.5px",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const amountValueStyle: CSSProperties = {
  fontFamily: emailFonts.mono,
  fontSize: "24px",
  fontWeight: 600,
  marginTop: "2px",
};

const bidMessageStyle: CSSProperties = {
  marginTop: "8px",
  fontSize: "13px",
  color: "#4a5a6a",
  fontStyle: "italic",
};

export interface EmailLayoutProps {
  /** `<title>` — the source used a distinct one per template. */
  title: string;
  /** Accent hex driving both the 4px stripe under the brand bar and the eyebrow. */
  accentColor: string;
  /** Small uppercase mono kicker above the headline ("New bid", "Bid accepted", …). */
  eyebrow: string;
  /** `<h1>` copy. */
  heading: ReactNode;
  /** Fine print in the closing cell. */
  footer: ReactNode;
  /** Lead paragraph, optional detail box, and CTA for this template. */
  children: ReactNode;
}

/** The shared card: head/fonts, page table, brand bar, accent stripe, content cell, footer cell. */
export function EmailLayout({
  title,
  accentColor,
  eyebrow,
  heading,
  footer,
  children,
}: EmailLayoutProps) {
  return (
    <Html lang="en">
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link href={GOOGLE_FONTS_HREF} rel="stylesheet" />
        <title>{title}</title>
      </Head>
      <body style={bodyStyle}>
        <table
          role="presentation"
          width="100%"
          cellPadding={0}
          cellSpacing={0}
          style={pageTableStyle}
        >
          <tr>
            <td align="center">
              <table
                role="presentation"
                width={560}
                cellPadding={0}
                cellSpacing={0}
                style={cardStyle}
              >
                <tr>
                  <td style={brandBarCellStyle}>
                    <span style={brandMarkStyle}>◈ DRONEMISSIONS</span>
                  </td>
                </tr>
                <tr>
                  <td
                    style={{ height: "4px", background: accentColor, fontSize: 0, lineHeight: 0 }}
                  >
                    {"\u00a0"}
                  </td>
                </tr>
                <tr>
                  <td style={contentCellStyle}>
                    <div style={{ ...eyebrowStyle, color: accentColor }}>{eyebrow}</div>
                    <h1 style={headingStyle}>{heading}</h1>
                    {children}
                  </td>
                </tr>
                <tr>
                  <td style={footerCellStyle}>
                    <p style={footerTextStyle}>{footer}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </Html>
  );
}

/** The lead paragraph shared by all five templates (`margin:0 0 18px;font-size:15px;…`). */
export function EmailParagraph({ children }: { children: ReactNode }) {
  return <p style={paragraphStyle}>{children}</p>;
}

export interface EmailButtonProps {
  href: string;
  /** CTA fill. Not always the layout accent — bid-rejected is grey-accented but keeps a blue CTA. */
  background: string;
  children: ReactNode;
}

/** The solid pill CTA at the end of the content cell. */
export function EmailButton({ href, background, children }: EmailButtonProps) {
  return (
    <a href={href} style={{ ...buttonStyle, background }}>
      {children}
    </a>
  );
}

export interface EmailAmountBoxProps {
  /** Uppercase mono caption ("Bid amount" / "Your winning bid"). */
  label: string;
  /** Rendered verbatim after a "$", exactly as Thymeleaf printed the BigDecimal. */
  amount: string | number;
  background: string;
  borderColor: string;
  labelColor: string;
  amountColor: string;
  /** Optional italic quote under the amount (the pilot's covering message on new-bid). */
  quote?: ReactNode;
}

/** The tinted amount panel used by new-bid and bid-accepted (identical markup, different palette). */
export function EmailAmountBox({
  label,
  amount,
  background,
  borderColor,
  labelColor,
  amountColor,
  quote,
}: EmailAmountBoxProps) {
  return (
    <table
      role="presentation"
      width="100%"
      cellPadding={0}
      cellSpacing={0}
      style={{ ...amountBoxStyle, background, border: `1px solid ${borderColor}` }}
    >
      <tr>
        <td style={amountBoxCellStyle}>
          <div style={{ ...amountLabelStyle, color: labelColor }}>{label}</div>
          <div style={{ ...amountValueStyle, color: amountColor }}>
            $<span>{amount}</span>
          </div>
          {quote ? (
            <div style={bidMessageStyle}>
              &ldquo;<span>{quote}</span>&rdquo;
            </div>
          ) : null}
        </td>
      </tr>
    </table>
  );
}
