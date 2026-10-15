import re, sys
sys.stdout.reconfigure(encoding='utf-8')

with open('index.html', 'r', encoding='utf-8') as f:
    text = f.read()

CHECKS = [
    ("1 — Name field",                      r'id="modalCustName"'),
    ("1 — Phone field [6-9]\\d{9} regex",   r'\[6-9\]\\d\{9\}'),
    ("1 — Phone HTML pattern [6-9][0-9]{9}",r'pattern="\[6-9\]\[0-9\]\{9\}"'),
    ("1 — Order type select",               r'id="modalOrderType"'),
    ("1 — Address field (conditional)",     r'id="modalCustAddress"'),
    ("1 — Notes field",                     r'id="modalOrderNotes"'),
    ("1 — Inline error box (aria alert)",   r'id="modalErrorMsg".*role="alert"'),
    ("1 — Address required only Delivery",  r'orderTypeVal === "Delivery" && !address'),
    ("2 — orderId SS + Date.now",           r'"SS" \+ String\(Date\.now'),
    ("2 — discount = couponApplied ?",      r'discount = couponApplied \?'),
    ("2 — taxable = subtotal - discount",   r'taxable.*subtotal.*discount'),
    ("2 — tax = Math.round(taxable * )",    r'Math\.round\(taxable \* CONFIG\.taxRate\)'),
    ("3 — URLSearchParams for UPI",         r'new URLSearchParams\(\{'),
    ("3 — pa: CONFIG.upiId",               r'pa: CONFIG\.upiId'),
    ("3 — pn: CONFIG.payee",               r'pn: CONFIG\.payee'),
    ("3 — am: total.toFixed(2)",           r'am: total\.toFixed\(2\)'),
    ("3 — cu: INR",                        r'cu: "INR"'),
    ("3 — tn: Order orderId",              r'tn: `Order \$\{orderId\}`'),
    ("3 — tr: orderId",                    r'tr: orderId'),
    ("3 — upi://pay? link",               r'upi://pay\?'),
    ("4 — Mobile Android/iPhone check",    r'/Android\|iPhone/i\.test'),
    ("4 — Mobile: open upiLink as href",   r'modalUpiAppBtn.*href|href.*upiLink'),
    ("4 — Desktop: QRCode(200x200)",       r'new QRCode.*width: 200'),
    ("4 — QRCode.js from cdnjs",           r'cdnjs\.cloudflare\.com.*qrcode'),
    ("4 — Show UPI ID on desktop",         r'modalUpiIdDisplay.*CONFIG\.upiId|CONFIG\.upiId.*modalUpiIdDisplay'),
    ("4 — Show amount on desktop",         r'modalUpiAmountDisplay'),
    ("4 — Copy UPI button",               r'id="modalCopyUpiBtn"'),
    ("5 — Send WhatsApp button",           r'id="modalSendWhatsappBtn"'),
    ("5 — wa.me/CONFIG.whatsapp",         r'wa\.me/\$\{CONFIG\.whatsapp\}'),
    ("5 — encodeURIComponent(message)",   r'encodeURIComponent\(message\)'),
    ("5 — Shop in message",               r'CONFIG\.shop.*message|message.*CONFIG\.shop'),
    ("5 — orderId in message",            r'd\.orderId'),
    ("5 — item lines name x qty = Rs",    r'x \$\{i\.quantity\} = Rs'),
    ("5 — Subtotal in message",           r'd\.subtotal'),
    ("5 — discount line in message",      r'd\.discount > 0.*message|message.*discount'),
    ("5 — Tax in message",                r'd\.tax'),
    ("5 — Total in message",              r'd\.total'),
    ("5 — UTR line in message",           r'screenshot/UTR'),
    ("6 — Payment notice text",           r'Payment is not confirmed automatically'),
    ("7 — cart.clear() after send",       r'cart\.clear\(\)'),
    ("7 — showToast after order",         r'showToast.*[Oo]rder.*[Cc]art|showToast.*Cart cleared'),
    ("A — role=dialog",                   r'role="dialog"'),
    ("A — aria-modal=true",              r'aria-modal="true"'),
    ("A — aria-labelledby",              r'aria-labelledby="checkoutModalTitle"'),
    ("A — Esc closes modal",             r'Escape.*closeCheckoutModal|closeCheckoutModal.*Escape'),
    ("A — Esc closes cart drawer",       r'cartDrawer\.classList\.contains.*open.*closeCartDrawer'),
    ("A — Focus on open",               r'modalCustName.*focus|focus.*modalCustName'),
    ("A — escapeHTML used in cart render",r'escapeHTML\(item\.name\)'),
    ("A — CONFIG.shop used",             r'CONFIG\.shop'),
    ("A — CONFIG.upiId used",            r'CONFIG\.upiId'),
    ("A — CONFIG.payee used",           r'CONFIG\.payee'),
    ("A — CONFIG.whatsapp used",        r'CONFIG\.whatsapp'),
    ("A — novalidate on form",          r'novalidate'),
    ("A — QRCode CDN (no secret key)",  r'qrcodejs.*1\.0\.0.*qrcode\.min\.js'),
]

passed = 0
failed = []
for label, pattern in CHECKS:
    ok = bool(re.search(pattern, text, re.DOTALL | re.IGNORECASE))
    if ok:
        passed += 1
    else:
        failed.append(label)
    print(f"  {'✅' if ok else '❌'} {label}")

print(f"\n{'='*50}")
print(f"PASSED {passed}/{len(CHECKS)}")
if failed:
    print("MISSING:")
    for f in failed:
        print(f"  ✗ {f}")
else:
    print("ALL SPEC REQUIREMENTS MET ✓")
