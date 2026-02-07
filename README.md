# Personal Expense Dashboard

A beautiful, interactive expense tracking dashboard built with HTML, CSS, and Chart.js.

![Dashboard Preview](Screenshot.png)

## 🎯 Features

- **Visual Analytics**: Interactive charts showing spending patterns
  - Monthly spending trends (line chart)
  - Category breakdown (doughnut chart)
  - Top merchants analysis (bar chart)
  - Card usage distribution (pie chart)

- **Multi-Year Analysis**:
  - **Multi-Select Year Picker**: Toggle pill buttons to select one or more years simultaneously (e.g. 2024 + 2025 combined)
  - **Year-over-Year Comparison**: Overlay chart comparing monthly spending trends across different years
  - **Accurate Monthly Average**: Counts unique year-month pairs with actual spending; months with no data are excluded from the average calculation

- **Smart Filtering**: Filter expenses by year (multi-select), month, category, and card

- **Summary Cards**: Quick overview of total spending, transactions, average per transaction, active months, and monthly average

- **Transaction List**: Detailed view of recent transactions

- **Hebrew Support**: Full RTL (Right-to-Left) language support

## 🚀 Live Demo

View the live dashboard once doenloaded.

## ⚠️ DISCLAIMER

**This tool is provided for educational and informational purposes only.**

- This dashboard is a visualization tool and does NOT provide financial advice
- I am not a financial advisor, accountant, or tax professional
- All financial data processing happens locally in your browser
- **You are solely responsible for:**
  - The accuracy of your financial data
  - Securing your personal financial information
  - Any financial decisions you make based on this tool
  - Compliance with applicable laws and regulations

**Security & Privacy:**
- Never commit real financial data to public repositories
- This tool does not transmit data to any server
- Keep your actual expense data files private and secure
- Use at your own risk

**No Warranty:**
This software is provided "AS IS" without warranty of any kind, express or implied. The author is not liable for any damages or losses resulting from use of this tool.

## 💻 Usage

1. Clone this repository
2. Open `index.html` in your browser
3. The dashboard will load sample data from `expense_data.json`

## 📊 Data Format

The dashboard expects data in the following JSON format:

```json
[
    {
        "date": "2024-01-01",
        "year": 2024,
        "month": "January",
        "merchant": "Merchant Name",
        "category": "Category Name",
        "card": "1234",
        "amount": 100.00
    }
]
```

> **Note**: Dates are now in ISO 8601 format (`YYYY-MM-DD`). Explicit `year` and `month` fields are required for filtering.

## � Migration Tool
If you have data in the old format (DD/MM/YY), use the included Python script to convert it:

```bash
python tools/convert_data.py input_data.json -o new_data.json
```

## 📄 PDF Converter Tool [NEW]
If you have a Bank Leumi credit card statement in PDF format, you can convert it directly to the dashboard's JSON format.

### Installation
```bash
pip install pdfplumber
```

### Usage

**Basic usage:**
```bash
python tools/pdf_to_json.py "path/to/your/statement.pdf" -o expenses.json
```

**Interactive mode** (categorize unknown merchants):
```bash
python tools/pdf_to_json.py "path/to/your/statement.pdf" -o expenses.json -i
```

The interactive mode (`-i` flag) will:
1. Identify all uncategorized merchants
2. Prompt you to select a category for each
3. Ask for a keyword to match (defaults to full merchant name)
4. Save the new rules to `category_rules.json` for future use

### Features
- **Automatic Categorization**: Matches merchants to categories using patterns in `tools/category_rules.json`.
- **Interactive Categorization**: Quickly categorize unknown merchants and save rules for future PDFs.
- **RTL Hebrew Support**: Correctly handles reversed Hebrew text from Bank Leumi statements.
- **Auto-Month/Year**: Calculates month names and years from transaction dates.
- **Installment Support**: Properly extracts installment transactions, recording the monthly payment amount.

## �🛡️ Security
- **XSS Protection**: Data rendering is sanitized to prevent Cross-Site Scripting attacks.
- **SRI Check**: External libraries (Chart.js) are loaded with Subresource Integrity hashes.

## 🔒 Privacy & Data Security

**IMPORTANT:** This repository includes sample data only for demonstration purposes.

**To use with your real data:**
1. Clone/download this repository to your local computer
2. Replace `expense_data.json` with your own data (keep it LOCAL only)
3. Open `index.html` locally in your browser
4. **NEVER commit or upload your real financial data to GitHub or any public repository**

The `.gitignore` file is configured to help prevent accidentally committing private data files.

## 🛠️ Built With

- HTML5
- CSS3 (with modern gradients and animations)
- JavaScript (Vanilla)
- [Chart.js](https://www.chartjs.org/) - For data visualization

## 📝 License

MIT License - Feel free to use and modify this dashboard for your personal or commercial projects.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.

## 🤝 Contributing

Feel free to fork this project and submit pull requests with improvements!

---

 | Not affiliated with any financial institution
