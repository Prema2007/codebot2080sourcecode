## 14-May-2026

### Database Changes
- Removed `user_number` column from `messages` table

### Backend Changes
- Updated message fetch query to retrieve WhatsApp number using JOIN with `customers` table
- Added relational mapping using `customer_id`

#### Table Renamed
- Renamed `vendor_documents` table to `vendor_kyc`

#### Columns Removed
- Removed `document_type` column
- Removed `document_number` column
- Removed `document_file` column

#### Columns Added
- Added `aadhar_number`
- Added `aadhar_front_image`
- Added `aadhar_back_image`

- Added `pan_number`
- Added `pan_image`

- Added `trade_license_number`
- Added `trade_license_image`

- Added `bank_account_name`
- Added `bank_account_number`
- Added `ifsc_code`

- Added `cancelled_cheque_image`
- Added `address_proof`

- Added `remarks`


#### Subscription Table Updates
- Added `auto_renew` column to manage automatic subscription renewal status
- Added `renewal_date` column to store subscription renewal date
- Added `last_payment_date` column to track latest payment date
- Added `next_billing_date` column for upcoming billing cycle tracking
- Added `cancel_reason` column to store subscription cancellation remarks/reasons



Suggested by Ranganath Sir.
Change Log
Added
vendor_payment_bank
vendor_payment_upi
vendor_payment_card
Foreign Keys
vendor_payment_bank.vendor_id -> vendors.vendor_id
vendor_payment_upi.vendor_id -> vendors.vendor_id
vendor_payment_card.vendor_id -> vendors.vendor_id
Security
Store UPI ID
Store Bank Details
Store Card Last 4 Digits

Do NOT store full card number
Do NOT store CVV
Do NOT store PIN

