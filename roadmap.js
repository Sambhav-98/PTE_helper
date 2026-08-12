const ROADMAP = [
  {
    id: 'phase-1',
    title: 'Learn the exam itself',
    timeframe: 'Day 1–2',
    steps: [
      {
        id: 'step-1-1',
        title: 'Understand the format',
        detail: 'Read through the test structure: 4 modules, ~2h15m total with no break, AI-scored 10–90 per skill, results in 1–2 business days.',
        why: "You can't optimize your prep without knowing what's actually being measured."
      },
      {
        id: 'step-1-2',
        title: 'Know your target score',
        detail: 'Use the PTE-to-IELTS comparison table to translate your required IELTS band (university or visa requirement) into a PTE target.',
        why: 'A concrete number gives every practice session a clear finish line.'
      }
    ]
  },
  {
    id: 'phase-2',
    title: 'Attack the highest-impact Speaking tasks first',
    timeframe: 'Week 1',
    steps: [
      {
        id: 'step-2-1',
        title: 'Read Aloud (★★★★★)',
        detail: 'Practice the 3-breathing-point structure and stress-word marking during prep time.',
        why: 'Very high score influence, and it feeds both your Speaking and Reading scores.'
      },
      {
        id: 'step-2-2',
        title: 'Repeat Sentence (★★★★★)',
        detail: 'Drill the 3-level practice strategy — mimicry, then mimic + initials, then full initial mapping — until note-taking feels automatic.',
        why: 'Feeds Speaking and Listening, and has the highest question count of any Speaking task (10–12 questions).'
      },
      {
        id: 'step-2-3',
        title: 'Re-tell Lecture (★★★★★)',
        detail: 'Practice the two-phase technique: hunt for keyword+adjective pairs during playback, then rebuild them into sentences with connector phrases during your 40 seconds.',
        why: 'Touches three skills at once — Speaking, Listening, and Writing.'
      }
    ]
  },
  {
    id: 'phase-3',
    title: 'Round out the rest of Speaking',
    timeframe: 'Week 1–2',
    steps: [
      {
        id: 'step-3-1',
        title: 'Describe Image (★★★)',
        detail: 'Pick one of the four templates (Balanced, Simple, Analytical, Academic) and rehearse it until it fits any chart type without thinking.',
        why: "Moderate weight, but a memorized template removes almost all the thinking load in the real test."
      },
      {
        id: 'step-3-2',
        title: 'Answer Short Question (★★)',
        detail: "Drill through the Level 1–3 practice sets and build the habit of answering instantly — never say \"I don't know.\"",
        why: 'Lowest weight of the Speaking tasks, but fast, easy points if you never freeze on response time.'
      }
    ]
  },
  {
    id: 'phase-4',
    title: 'Writing',
    timeframe: 'Week 2',
    steps: [
      {
        id: 'step-4-1',
        title: 'Summarize Written Text',
        detail: 'Practice the 6-step strategy: skim, underline key ideas, select 2–3 points, connect them with academic connectors, write one sentence, proofread.',
        why: 'Counts toward both your Writing and Reading scores.'
      },
      {
        id: 'step-4-2',
        title: 'Write Essay',
        detail: 'Memorize the 5-paragraph essay template and practice filling it with different topics inside the 20-minute limit.',
        why: 'The single highest-weighted Writing task — Content and Written Discourse are both scored at the top weight tier.'
      }
    ]
  },
  {
    id: 'phase-5',
    title: 'Reading & Listening familiarity',
    timeframe: 'Week 2–3',
    steps: [
      {
        id: 'step-5-1',
        title: 'Learn every Reading task type',
        detail: 'Get comfortable with all five Reading formats and their time budgets — Fill in the Blanks (two variants), Multiple Choice (single and multiple answer), and Re-order Paragraphs.',
        why: 'Familiarity with format alone saves time you can redirect into actually answering.'
      },
      {
        id: 'step-5-2',
        title: 'Build listening stamina',
        detail: 'The Listening module is the longest section (30–43 minutes). Practice sustained focus across SST, WFD, HIW, and FIB tasks in one sitting.',
        why: 'Fatigue late in a 2h15m test is a bigger risk than not knowing the format.'
      }
    ]
  },
  {
    id: 'phase-6',
    title: 'Full mock tests',
    timeframe: 'Week 3–4',
    steps: [
      {
        id: 'step-6-1',
        title: 'Run at least 2–3 full timed mocks',
        detail: 'Simulate the full 2h15m, no-break format end to end, including the unscored Personal Introduction.',
        why: 'Pacing under real time pressure is impossible to fake with untimed practice.'
      },
      {
        id: 'step-6-2',
        title: 'Review mistakes in your Notebook',
        detail: 'After each mock, save the tasks you struggled with as notes and re-drill just those task types before the next mock.',
        why: 'Targeted correction beats repeating the same broad practice.'
      }
    ]
  },
  {
    id: 'phase-7',
    title: 'Final few days',
    timeframe: '2–3 days before',
    steps: [
      {
        id: 'step-7-1',
        title: "Taper, don't cram",
        detail: 'Light review only — re-read your saved notes, redo one or two of the ★★★★★ tasks, and stop adding new material.',
        why: 'Fluency and pronunciation scoring reward a calm, well-rested voice more than last-minute cramming.'
      },
      {
        id: 'step-7-2',
        title: 'Sort out test-day logistics',
        detail: 'Confirm your test slot, ID requirements, and equipment (quiet room, working mic/headset) a day ahead.',
        why: 'Technical hiccups during Speaking recording tasks cost real points if you\'re scrambling to fix them mid-test.'
      }
    ]
  }
];

module.exports = { ROADMAP };
