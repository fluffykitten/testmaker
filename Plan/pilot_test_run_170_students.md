# Blueprint: 170-Student Exam Mode Pilot & Stress Test

**Quiz Title**: ICM Cambridge Exam System Pilot (170-Student Drill)  
**Quiz Code**: `ICM170`  
**Direct Access URL**: `/#/student?code=ICM170`  
**Duration**: 20 Minutes Total  
**Teacher Unlock PIN**: `2026`  
**Target Audience**: 170 High School Students (Insan Cendekia Madani)  
**Total Questions**: 10 Questions  
**Status**: Ready for Generation & System Publishing  

---

## 1. Test Objectives & Hardware Readiness Matrix

This pilot assessment is designed as an interactive orientation and hardware stress test to ensure all 170 student devices (laptops, Chromebooks, tablets) perform reliably under live examination conditions.

| Tested System Capability | Question # | Subject | Interactive Component Tested |
| :--- | :--- | :--- | :--- |
| **🧪 Periodic Table Drawer** | **Q1** | Chemistry (0620) | Sliding drawer, element search, atomic mass / group lookup (`🧪 Periodic Table`) |
| **🧮 Scientific Calculator** | **Q2** | Physics (0625) | Floating draggable calculator modal, exponent/fraction operations (`🧮 Calculator`) |
| **🎧 Audio Listening Player** | **Q3** | English (0510) | Cloud audio stream, play limit counter (2 plays), volume slider, headphone check |
| **🔬 In-Stem Biology Diagram** | **Q4** | Biology (0610) | Direct high-res diagram rendering of leaf cross-section & stomata/guard cells |
| **📖 Resource Booklet / Maps** | **Q5** | Geography (0460) | Sidecar drawer, high-res image pinch-zoom, multi-subquestion navigation (`📖 Resource Booklet`) |
| **📊 Interactive Data Table** | **Q6** | Economics (0455) | Direct cell editing in tabular grid (`ExamDataTable` with `is_blank: true`) |
| **☑️ Multi-Select Checkboxes** | **Q7** | Science & Econ | Strict multi-selection constraints ("Select 2 options"), partial credit scoring |
| **🔤 Inline Gap Cloze** | **Q8** | Chemistry Energetics | Inline dropdown gaps, keyboard <kbd>Tab</kbd> traversal across blank sentences |
| **🕌 Arabic RTL & Arabic Letters**| **Q9** | Bahasa Arab | Right-to-left (RTL) Arabic typography, Arabic option letters (`أ`, `ب`, `ج`, `د`) |
| **🇮🇩 Bahasa Indonesia Text** | **Q10** | Bahasa Indonesia | Indonesian language reading comprehension, diacritics, and text analysis |
| **🛡️ Proctor & Security Guard** | All | All Subjects | Fullscreen lock, 5s recovery grace period, tiered lock screen, teacher PIN unlock (`2026`) |

---

## 2. Complete 10-Question Blueprint

### Q1: Chemistry — Cambridge IGCSE (0620)
* **Topic**: Periodic Trends & Atomic Structure
* **Question Style**: `Multiple Choice`
* **Marks**: 2 Marks
* **Interaction**: Opens the **Periodic Table Drawer** (`🧪 Periodic Table`).
* **Question Text**:
  > *"Use the on-screen **Periodic Table** (🧪 button in the top bar) to locate the element with atomic number $17$ (Chlorine, $\text{Cl}$). Which row correctly states its relative atomic mass ($A_r$) to one decimal place and its Group in the Periodic Table?"*
* **Options**:
  - **A**: Relative atomic mass: $35.5$ • Group: $\text{VII}$ (Halogens) *(Correct)*
  - **B**: Relative atomic mass: $17.0$ • Group: $\text{VII}$ (Halogens)
  - **C**: Relative atomic mass: $35.5$ • Group: $\text{VIII}$ (Noble gases)
  - **D**: Relative atomic mass: $71.0$ • Group: $\text{VII}$ (Halogens)

---

### Q2: Physics — Cambridge IGCSE (0625)
* **Topic**: Mechanics & Energy Calculations
* **Question Style**: `Calculation`
* **Marks**: 3 Marks
* **Interaction**: Opens the **Scientific Calculator** (`🧮 Calculator`).
* **Question Text**:
  > *"An electric test vehicle of mass $m = 1200\text{ kg}$ accelerates uniformly from rest to a velocity of $v = 25\text{ m/s}$.  
  > Using the on-screen **Calculator**, calculate the kinetic energy ($E_k$) of the vehicle in **Joules ($\text{J}$)**.  
  > Formula: $$E_k = \frac{1}{2} m v^2$$  
  > Enter your numerical answer in the box below."*
* **Expected Answer**: `375000` (Acceptable range / formatted: `375,000`, `3.75e5`, `375000 J`)

---

### Q3: English as a Second Language — Cambridge IGCSE (0510/0511)
* **Topic**: Listening Comprehension & Auditory Verification
* **Question Style**: `Multiple Choice`
* **Marks**: 2 Marks
* **Audio Track**: External high-reliability CDN stream
* **Audio Play Limit**: 2 Plays allowed
* **Question Text**:
  > *"Listen to the short environmental announcement regarding the school's renewable energy workshop. You may play the recording up to **2 times**.  
  > According to the audio broadcast, at what time does the interactive robotics exhibition begin?"*
* **Options**:
  - **A**: 09:30 AM
  - **B**: 10:15 AM *(Correct)*
  - **C**: 11:45 AM
  - **D**: 02:00 PM

---

### Q4: Cambridge Biology — Cambridge IGCSE (0610) *(Reordered to #4)*
* **Topic**: Plant Nutrition, Leaf Anatomy & Gas Exchange
* **Question Style**: `Structured` (with In-Stem Microscopic Diagram)
* **Marks**: 3 Marks
* **Interaction**: On-screen SVG/Diagram inspection embedded directly within the question card.
* **Question Text**:
  > *"Fig. 4.1 shows a transverse section through a dicotyledonous leaf as viewed under a high-power light microscope.*
  > 
  > *(a) State the letter (**A**, **B**, **C**, or **D**) that identifies the **palisade mesophyll layer**, which contains the highest concentration of chloroplasts for photosynthesis. [1 mark]*  
  > *(b) Name the microscopic pores located in the lower epidermis that allow carbon dioxide to diffuse into the leaf for photosynthesis. [1 mark]*  
  > *(c) State the name of the specialized pairs of cells that regulate the opening and closing of these pores to control transpiration. [1 mark]"*
* **Sub-questions**:
  - `4(a)`: Short Answer — Expected: `"B"` (Palisade mesophyll)
  - `4(b)`: Short Answer — Expected: `"stomata"` (or `"stoma"`)
  - `4(c)`: Short Answer — Expected: `"guard cells"` (or `"guard cell"`)

---

### Q5: Cambridge Geography — Cambridge IGCSE (0460)
* **Topic**: Geographical Skills & Resource Booklet Inspection
* **Question Style**: `Structured`
* **Marks**: 4 Marks (2 sub-questions)
* **Interaction**: Opens the **Resource Booklet Drawer** (`📖 Resource Booklet` - Fig. 5.1 Topographic Survey Map & Volcano Cross-section).
* **Question Text**:
  > *"Study **Fig. 5.1** in the **Resource Booklet** (📖 button in the top bar), which shows a topographic survey map extract and satellite photo of Mount Merapi.*
  > 
  > *(a) Identify the volcanic feature marked at location **X** on the map. [1 mark]*  
  > *(b) Calculate the approximate difference in elevation between the crater rim ($2930\text{ m}$) and the observation outpost ($1280\text{ m}$). [1 mark]*  
  > *(c) State TWO human activities vulnerable to pyroclastic flows identified in the valley settlement. [2 marks]"*
* **Sub-questions**:
  - `5(a)`: Short Answer — Expected: `"crater"` or `"caldera"` or `"crater vent"`
  - `5(b)`: Calculation — Expected: `1650` (meters)
  - `5(c)`: Short Answer — Expected: `"farming, agriculture, tourism, mining"`

---

### Q6: Cambridge Economics — Cambridge IGCSE (0455)
* **Topic**: The Allocation of Resources & Equilibrium Pricing
* **Question Style**: `Structured` (with Interactive Data Table)
* **Marks**: 3 Marks
* **Interactive Element**: `ExamDataTable` with interactive blank cells (`is_blank: true`).
* **Question Text**:
  > *"The table below shows the weekly market demand and supply schedules for organic apples in a local market.  
  > Study the data and type the missing values directly into the empty cells in the table."*
* **Table Structure**:
  | Price per kg ($) | Quantity Demanded (kg) | Quantity Supplied (kg) | Market State |
  | :--- | :--- | :--- | :--- |
  | \$2.00 | 500 | 200 | Shortage (-300 kg) |
  | \$3.00 | 400 | 300 | Shortage (-100 kg) |
  | **\$4.00** | **350** | **350** | **[Equilibrium / Balanced]** *(Blank Cell)* |
  | \$5.00 | 250 | 450 | Surplus (+200 kg) |
* **Question Part 6(b)**:
  > *"State the equilibrium market price per kilogram."*  
  > Expected: `"$4"` or `"$4.00"` or `"4"`

---

### Q7: Multi-Discipline Science & Economics — Multi-Select
* **Topic**: Environmental Economics & Public Goods
* **Question Style**: `Multiple Select`
* **Marks**: 2 Marks
* **Interaction**: Checkboxes with selection counter.
* **Question Text**:
  > *"Which **TWO** of the following government policies are direct market-based interventions designed to reduce carbon emissions and environmental pollution?  
  > **(Select exactly TWO options)**"*
* **Options**:
  - **A**: Levying a Pigouvian carbon tax on high-polluting industries *(Correct)*
  - **B**: Providing unconditional cash grants to fossil fuel refineries
  - **C**: Establishing an emissions trading permit system (cap-and-trade) *(Correct)*
  - **D**: Imposing a mandatory maximum price ceiling on solar panels
  - **E**: Banning public transport usage during peak hours

---

### Q8: Chemistry — Inline Gap Cloze
* **Topic**: Thermochemistry & Energetics
* **Question Style**: `Fill in the Blank` (Inline Gaps)
* **Marks**: 3 Marks
* **Interaction**: Embedded gap dropdowns and inline text boxes within paragraph prose.
* **Question Text**:
  > *"Complete the scientific passage below regarding chemical energetics:*  
  > *During an exothermic chemical reaction, heat energy is **[released|absorbed]** to the surroundings. This transfer of thermal energy causes the temperature of the surrounding medium to **[increase|decrease]**. The enthalpy change ($\Delta H$) for any exothermic reaction has a **[negative|positive]** sign."*
* **Correct Answers**:
  - Gap 1: `released`
  - Gap 2: `increase`
  - Gap 3: `negative`

---

### Q9: Bahasa Arab (Arabic Language & Grammar)
* **Topic**: Nahwu / Sharaf & Arabic Comprehension
* **Question Style**: `Multiple Choice` (RTL Arabic with Arabic Option Letters: أ, ب, ج, د)
* **Marks**: 2 Marks
* **Interaction**: Automatically engages RTL layout and Arabic option badges `أ`, `ب`, `ج`, `د`.
* **Question Text**:
  > *"اخْتَرْ الْجُمْلَةَ الَّتِي تَحْتَوِي عَلَى **فِعْلٍ مَاضٍ** صَحِيحٍ مِمَّا يَلِي:"*
* **Options**:
  - **أ**: ذَهَبَ الطَّالِبُ إِلَى الْمَدْرَسَةِ مُبَكِّرًا *(Correct)*
  - **ب**: يَكْتُبُ التِّلْمِيذُ الدَّرْسَ فِي الدَّفْتَرِ
  - **ج**: اِقْرَأْ كِتَابَكَ بِعِنَايَةٍ
  - **د**: سَوْفَ يَنْجَحُ الْمُجْتَهِدُ فِي الاخْتِبَارِ

---

### Q10: Bahasa Indonesia (Literasi & Kaidah Kebahasaan)
* **Topic**: Teks Eksplanasi Ilmiah & Kalimat Efektif
* **Question Style**: `Multiple Choice`
* **Marks**: 2 Marks
* **Question Text**:
  > *"Bacalah kutipan teks eksplanasi ilmiah berikut dengan cermat:*  
  > 
  > *'Fotosintesis merupakan proses biokimia pembentukan karbohidrat dari bahan anorganik yang dilakukan oleh tumbuhan berklorofil dengan bantuan energi cahaya matahari. Proses ini tidak hanya menghasilkan glukosa sebagai sumber energi bagi tumbuhan, tetapi juga melepaskan oksigen ke atmosfer bumi yang sangat esensial bagi kelangsungan hidup organisme aerobik.'*  
  > 
  > *Berdasarkan teks di atas, manakah pernyataan berikut yang paling tepat mengenai fungsi ekologis utama dari proses fotosintesis?"*
* **Options**:
  - **A**: Mengurangi kelembapan udara secara drastis di ekosistem hutan tropis
  - **B**: Memproduksi gas oksigen yang vital bagi organisme aerobik serta menyediakan cadangan energi organik *(Correct)*
  - **C**: Mengubah energi kinetik menjadi energi termal di dalam vakuola tumbuhan
  - **D**: Menghentikan siklus karbon di lapisan biosfer bumi

---

## 3. Exam Platform Execution & Publishing Config

```json
{
  "id": "pilot-exam-170",
  "quizCode": "ICM170",
  "title": "ICM Cambridge Exam System Pilot (170-Student Drill)",
  "durationMinutes": 20,
  "isExamMode": true,
  "securityEnabled": true,
  "requireTeacherUnlock": true,
  "teacherPin": "2026",
  "allowCalculator": true,
  "calculatorType": "scientific",
  "allowPeriodicTable": true,
  "allowScratchpad": true,
  "requireStudentPin": false,
  "limitOneAttempt": true,
  "hideEmergencyExamButton": false
}
```

---

## 4. Student Onboarding & Invigilation Briefing (Cheat Sheet)

* **Student Entry**: Go to `/#/student`, type `ICM170`, select name from the autocomplete dropdown, and click **Begin Exam Now**.
* **Invigilator Unlock**: If any student accidentally trips the fullscreen lock, enter PIN `2026` on their screen or click **Remote Unlock** from the Live Invigilator Cockpit.
* **Total Running Time**: 20 minutes (Recommended to run in 2 waves or 1 synchronized sitting across classrooms).
