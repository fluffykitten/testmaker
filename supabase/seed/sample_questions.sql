-- ============================================================================
-- Seed Data — Sample IGCSE Chemistry (0620) Questions (Container Format)
-- Run this in your Supabase SQL Editor
-- ============================================================================

-- Clean existing sample data
DELETE FROM questions WHERE syllabus_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
DELETE FROM syllabuses WHERE id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

-- Insert sample syllabus
INSERT INTO syllabuses (id, subject_name, subject_code) VALUES
    ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Chemistry', '0620');

-- Ensure options column exists
ALTER TABLE questions ADD COLUMN IF NOT EXISTS options JSONB DEFAULT '[]'::jsonb;

-- Insert sample questions
INSERT INTO questions (syllabus_id, year, series, paper_number, question_number, parent_question_id, question_text, question_style, topic, sub_topic, difficulty, marks, options, sub_questions, mark_scheme)
VALUES

-- Q1: Paper 41 (Theory / Structured Container with (a) and (b))
(
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    2023, 'May/June', 41, '1', 'Q1',
    $q$Diffusion and kinetic particle theory are investigated in laboratory experiments with gases.$q$,
    'Structured',
    'States of Matter', 'Diffusion & Particle Theory',
    'Medium', 5,
    '[]'::jsonb,
    $q$[
        {
            "sub_id": "(a)",
            "question_text": "Define the term diffusion.",
            "marks": 2,
            "mark_scheme": "The net movement of particles from a region of higher concentration to a region of lower concentration [1]; down a concentration gradient as a result of their random movement [1]"
        },
        {
            "sub_id": "(b)",
            "question_text": "Cotton wool soaked in concentrated hydrochloric acid ($HCl$) and concentrated aqueous ammonia ($NH_3$) are placed at opposite ends of a long glass tube. Explain why the white solid ring of $NH_4Cl$ forms closer to the $HCl$ end.",
            "marks": 3,
            "mark_scheme": "$HCl$ molecules have a larger relative molecular mass ($M_r = 36.5$) than $NH_3$ ($M_r = 17$) [1]; $NH_3$ molecules travel faster / diffuse at a faster rate [1]; therefore $NH_3$ covers more distance before the two gases react [1]"
        }
    ]$q$::jsonb,
    '{"marking_points": ["See sub-question breakdown [5]"], "acceptable_answers": []}'::jsonb
),

-- Q2: Paper 41 (Stoichiometry & Quantitative Chemistry Structured Container)
(
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    2023, 'May/June', 41, '2', 'Q2',
    $q$Limestone consists mainly of calcium carbonate, $CaCO_3$. When heated strongly, it undergoes thermal decomposition:
$$CaCO_3(s) \xrightarrow{\Delta} CaO(s) + CO_2(g)$$
($A_r$: Ca = 40, C = 12, O = 16)$q$,
    'Structured',
    'Stoichiometry', 'Mole Calculations',
    'Medium', 6,
    '[]'::jsonb,
    $q$[
        {
            "sub_id": "(a)",
            "question_text": "Calculate the relative formula mass ($M_r$) of calcium carbonate, $CaCO_3$.",
            "marks": 2,
            "mark_scheme": "$40 + 12 + (3 \\times 16) = 100$ [2]"
        },
        {
            "sub_id": "(b)",
            "question_text": "Calculate the number of moles in $25.0\\text{ g}$ of $CaCO_3$. Use the formula: $n = \\frac{m}{M_r}$.",
            "marks": 2,
            "mark_scheme": "$n = \\frac{25.0}{100} = 0.25\\text{ mol}$ [2]"
        },
        {
            "sub_id": "(c)",
            "question_text": "Calculate the volume of $CO_2$ gas produced at standard room temperature and pressure (r.t.p.) from the decomposition of $25.0\\text{ g}$ of $CaCO_3$. (1 mole of gas occupies $24\\text{ dm}^3$ at r.t.p.)",
            "marks": 2,
            "mark_scheme": "$\\text{Moles of } CO_2 = 0.25\\text{ mol}$ [1]; $\\text{Volume} = 0.25 \\times 24 = 6.0\\text{ dm}^3$ [1]"
        }
    ]$q$::jsonb,
    '{"marking_points": ["See sub-question breakdown [6]"], "acceptable_answers": []}'::jsonb
),

-- Q3: Paper 41 (Chemical Energetics & Enthalpy Profile Structured Container)
(
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    2023, 'May/June', 41, '3', 'Q3',
    $q$The combustion of methane is an exothermic reaction:
$$CH_4(g) + 2O_2(g) \rightarrow CO_2(g) + 2H_2O(l) \quad \Delta H = -890\text{ kJ/mol}$$$q$,
    'Structured',
    'Chemical Energetics', 'Exothermic Reactions',
    'Hard', 5,
    '[]'::jsonb,
    $q$[
        {
            "sub_id": "(a)",
            "question_text": "Explain in terms of bond breaking and bond making why this reaction is exothermic.",
            "marks": 3,
            "mark_scheme": "Bond breaking is endothermic / requires energy [1]; bond making is exothermic / releases energy [1]; more energy is released forming bonds in products than is absorbed breaking bonds in reactants [1]"
        },
        {
            "sub_id": "(b)",
            "question_text": "State the effect of adding a suitable catalyst on the activation energy ($E_a$) and enthalpy change ($\\Delta H$) of the reaction.",
            "marks": 2,
            "mark_scheme": "Activation energy ($E_a$) is lowered [1]; enthalpy change ($\\Delta H$) remains unchanged [1]"
        }
    ]$q$::jsonb,
    '{"marking_points": ["See sub-question breakdown [5]"], "acceptable_answers": []}'::jsonb
),

-- Q4: Paper 21 (Multiple Choice — Atomic Structure)
(
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    2023, 'May/June', 21, '4', 'Q4',
    $q$An atom of element X has the electronic configuration $2, 8, 7$. Which statement about element X is correct?$q$,
    'Multiple Choice',
    'Atomic Structure', 'Electronic Configuration',
    'Easy', 1,
    $q$[
        "A: It belongs to Group II and Period 7",
        "B: It forms a basic oxide",
        "C: It belongs to Group VII and Period 3",
        "D: It forms a positive ion with a charge of +1"
    ]$q$::jsonb,
    '[]'::jsonb,
    '{"marking_points": ["Option C: It belongs to Group VII and Period 3 of the Periodic Table [1]"], "acceptable_answers": ["C"]}'::jsonb
),

-- Q5: Paper 21 (Multiple Choice — Acids & Bases)
(
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    2023, 'May/June', 21, '5', 'Q5',
    $q$Which oxide dissolves in water to form an acidic solution with a pH less than 7?$q$,
    'Multiple Choice',
    'Acids, Bases & Salts', 'Oxides',
    'Easy', 1,
    $q$[
        "A: $CaO$ (Calcium oxide)",
        "B: $SO_2$ (Sulfur dioxide)",
        "C: $Na_2O$ (Sodium oxide)",
        "D: $MgO$ (Magnesium oxide)"
    ]$q$::jsonb,
    '[]'::jsonb,
    '{"marking_points": ["Option B: $SO_2$ (Sulfur dioxide) [1]"], "acceptable_answers": ["B"]}'::jsonb
),

-- Q6: Paper 41 (Halogens Group VII Data Table)
(
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    2023, 'May/June', 41, '6', 'Q6',
    $q$Table 6.1 shows some physical properties of the elements in Group VII of the Periodic Table.

| Halogen | Formula of molecule | State at r.t.p. | Boiling point / $^\circ\text{C}$ |
|---|---|---|---|
| Chlorine | $Cl_2$ | Gas | $-34$ |
| Bromine | $Br_2$ | Liquid | $59$ |
| Iodine | $I_2$ | Solid | $184$ |
| Astatine | $At_2$ | Solid | $337$ |$q$,
    'Structured',
    'The Periodic Table', 'Group VII Elements',
    'Medium', 4,
    '[]'::jsonb,
    $q$[
        {
            "sub_id": "(a)",
            "question_text": "Describe the trend in boiling points of the halogens down Group VII shown in Table 6.1.",
            "marks": 1,
            "mark_scheme": "Boiling points increase down the group [1]"
        },
        {
            "sub_id": "(b)",
            "question_text": "Explain in terms of intermolecular forces why the boiling point increases down Group VII.",
            "marks": 2,
            "mark_scheme": "Molecules increase in size / have more electrons [1]; attractive intermolecular forces become stronger, requiring more energy to overcome [1]"
        },
        {
            "sub_id": "(c)",
            "question_text": "Predict the appearance of astatine at room temperature.",
            "marks": 1,
            "mark_scheme": "Black / dark grey solid [1]"
        }
    ]$q$::jsonb,
    '{"marking_points": ["See sub-question breakdown [4]"], "acceptable_answers": []}'::jsonb
);

-- Disable RLS on all tables so past paper uploads and test creation work seamlessly
ALTER TABLE syllabuses DISABLE ROW LEVEL SECURITY;
ALTER TABLE questions DISABLE ROW LEVEL SECURITY;
ALTER TABLE custom_tests DISABLE ROW LEVEL SECURITY;
