# agkit-fillpdf

A Cloudflare Worker that reads the fields of a fillable PDF form and fills them.

The Worker has two endpoints. `POST /fields` returns the fields of a PDF form as JSON. `POST /fill` writes your values into the fields and returns the filled PDF. You send the form as a file upload or as a URL to the form. The Worker keeps no state and stores nothing.

## Hosted instance

A public instance runs at `https://fillpdf.agkit.io`:

```bash
curl -X POST https://fillpdf.agkit.io/fields -F url=https://www.irs.gov/pub/irs-pdf/fw9.pdf
```

The instance has no authentication and no rate limit. For private or high-volume use, deploy your own copy.

## Quick start

```bash
git clone https://github.com/kbhalerao/agkit.io-fillpdf.git
cd agkit.io-fillpdf
pnpm install
pnpm dev
```

The Worker runs at `http://localhost:8787`. List the fields of the IRS W-9 form:

```bash
curl -X POST localhost:8787/fields -F url=https://www.irs.gov/pub/irs-pdf/fw9.pdf
```

## API

Both endpoints accept `POST` only. Each request must carry the PDF form in one of two ways:

| Content-Type | PDF | Fill values (`/fill` only) |
|--------------|-----|----------------------------|
| `multipart/form-data` | `file` (the PDF upload) or `url` (a text field) | `data`, a JSON string |
| `application/json` | `url` | `data`, a JSON object |

When a request contains both `file` and `url`, the Worker uses `file`. The `url` must use `http` or `https`. The maximum PDF size is 20 MB.

### `POST /fields`

This endpoint returns every field in the order the form lists them.

```bash
# Upload a file
curl -X POST localhost:8787/fields -F file=@fw9.pdf

# Send a URL
curl -X POST localhost:8787/fields \
  -H 'content-type: application/json' \
  -d '{"url": "https://www.irs.gov/pub/irs-pdf/fw9.pdf"}'
```

Response `200`, `application/json`:

```json
{
  "xfa": false,
  "fields": [
    {
      "name": "topmostSubform[0].Page1[0].f1_01[0]",
      "label": "1 Name of entity/individual. An entry is required. (For a sole proprietor ...)",
      "description": "Page 1. Print or type. See Specific Instructions on page 3. 1. Name of entity/individual. ...",
      "page": 1,
      "type": "text",
      "required": false,
      "readOnly": false,
      "value": null,
      "maxLength": null,
      "multiline": false
    },
    {
      "name": "topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[0]",
      "label": "Individual/sole proprietor",
      "description": "3a. Check the appropriate box for federal tax classification of the entity/individual ...",
      "page": 1,
      "type": "checkbox",
      "required": false,
      "readOnly": false,
      "value": false
    }
  ]
}
```

Every field has these keys:

| Key | Type | Meaning |
|-----|------|---------|
| `name` | string | The fully qualified field name. Use it as the key in `/fill`. |
| `label` | string or `null` | The text printed with the field on the page, for a person to read. |
| `description` | string or `null` | Longer screen-reader text, when the form has it and it differs from `label`. A Yes or No checkbox has `label` "Yes" and a `description` that states the question. |
| `page` | number or `null` | The 1-based page that shows the field. |
| `type` | string | `text`, `checkbox`, `radio`, `dropdown`, `optionlist`, `signature` or `button` |
| `required` | boolean | The form marks the field as required. |
| `readOnly` | boolean | The form marks the field as read-only. |

Some types add more keys:

| Type | Extra keys |
|------|------------|
| `text` | `value` (string or `null`), `maxLength` (number or `null`), `multiline` (boolean) |
| `checkbox` | `value` (boolean) |
| `radio` | `value` (string or `null`), `options` (string array) |
| `dropdown` | `value` (string array), `options`, `multiselect` (boolean), `editable` (boolean) |
| `optionlist` | `value` (string array), `options`, `multiselect` (boolean) |

`label` comes from the field's tooltip (`/TU`). A hybrid form, such as most IRS forms, has no tooltip. For that form the Worker reads `label` and `description` from the XFA template, matched by field name. A form with neither source returns `null` for both.

`xfa` is `true` when the PDF also contains an XFA form. See [Limits](#limits).

### `POST /fill`

This endpoint writes the values in `data` into the form and returns the filled PDF. `data` maps each field `name` to a value. Fields you leave out keep their current values.

```bash
# Upload a file
curl -X POST localhost:8787/fill -o filled.pdf \
  -F file=@fw9.pdf \
  -F 'data={"topmostSubform[0].Page1[0].f1_01[0]": "Jane Doe"}'

# Send a URL
curl -X POST localhost:8787/fill -o filled.pdf \
  -H 'content-type: application/json' \
  -d '{
        "url": "https://www.irs.gov/pub/irs-pdf/fw9.pdf",
        "data": {
          "topmostSubform[0].Page1[0].f1_01[0]": "Jane Doe",
          "topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[0]": true
        }
      }'
```

Response `200`, `application/pdf`, with `Content-Disposition: attachment; filename="filled.pdf"`.

Each field type accepts one kind of value:

| Type | Value |
|------|-------|
| `text` | A string, number or boolean. The Worker writes numbers and booleans as text. |
| `checkbox` | `true` or `false` |
| `radio` | One string from `options` |
| `dropdown`, `optionlist` | One string from `options`, or an array of strings when `multiselect` is `true`. An `editable` dropdown also accepts a string that is not in `options`. |

`null` clears a field of any of these types. The `value` keys from `/fields` are valid `data` values, so the field list can serve as a fill template:

```bash
curl -s -X POST localhost:8787/fields -F file=@fw9.pdf \
  | jq '.fields | map({(.name): .value}) | add' > data.json
# edit data.json, then:
curl -s -X POST localhost:8787/fill -F file=@fw9.pdf -F 'data=<data.json' -o filled.pdf
```

`signature` and `button` fields cannot be filled.

The Worker checks every entry before it writes any value. If one entry fails, the Worker writes nothing and returns `400` with a `details` object. `details` names each failed field and gives the reason:

```json
{
  "error": "Some fields cannot be filled",
  "details": {
    "topmostSubform[0].Page1[0].f1_99[0]": "No field with this name",
    "topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[0]": "Checkbox takes true or false"
  }
}
```

### Errors

Every error response is JSON with an `error` string. A `/fill` validation failure also has `details`.

| Status | Cause |
|--------|-------|
| `400` | The request has no PDF, the PDF cannot be read, `data` is missing or is not an object, or a fill value is invalid. |
| `404` | The path is not `/fields` or `/fill`. |
| `405` | The method is not `POST`. |
| `413` | The PDF is larger than 20 MB. |
| `415` | The Content-Type is not `multipart/form-data` or `application/json`. |
| `502` | The `url` returned a non-2xx status. |

### Calling from code

JavaScript:

```js
const body = new FormData();
body.append('file', pdfBlob, 'form.pdf');
body.append('data', JSON.stringify({ 'topmostSubform[0].Page1[0].f1_01[0]': 'Jane Doe' }));

const res = await fetch('http://localhost:8787/fill', { method: 'POST', body });
if (!res.ok) throw new Error(JSON.stringify(await res.json()));
const filled = await res.blob();
```

Python:

```python
import json, requests

with open("fw9.pdf", "rb") as f:
    res = requests.post(
        "http://localhost:8787/fill",
        files={"file": f},
        data={"data": json.dumps({"topmostSubform[0].Page1[0].f1_01[0]": "Jane Doe"})},
    )
res.raise_for_status()
open("filled.pdf", "wb").write(res.content)
```

## Deploy

```bash
pnpm wrangler login
pnpm deploy
```

Wrangler prints the URL of your Worker, for example `https://agkit-fillpdf.<your-subdomain>.workers.dev`. To change the Worker name, edit `name` in `wrangler.jsonc`.

The `production` environment in `wrangler.jsonc` deploys the hosted instance to `fillpdf.agkit.io`. It works only with access to the `agkit.io` Cloudflare account.

## Limits

- **AcroForm only.** The Worker reads and fills AcroForm fields. A PDF with only an XFA form returns `"xfa": true` and an empty `fields` array, and cannot be filled. When a PDF has both, `/fill` removes the XFA part so that PDF viewers show the filled AcroForm fields.
- **WinAnsi text only.** The Worker draws field text in Helvetica, which covers Latin-1 plus curly quotes, dashes and `€`. Other characters, for example Devanagari or CJK, cause a `400`.
- **No flattening.** The fields in the output stay editable.
- **No encrypted PDFs.** A password-protected PDF returns `400`.
- **No access control.** The Worker has no authentication and no rate limit. It fetches any public `http` or `https` URL that a caller sends. Add Cloudflare Access, an API key check or a WAF rate-limit rule before you expose it to the internet.

## Development

```bash
pnpm dev      # local Worker on :8787
pnpm test     # Vitest
pnpm check    # TypeScript
```

The Worker is one file, `src/index.ts`. It uses [`@cantoo/pdf-lib`](https://github.com/cantoo-scribe/pdf-lib), a maintained fork of `pdf-lib`.

## License

MIT. See [LICENSE](LICENSE). `@cantoo/pdf-lib` is also MIT.
