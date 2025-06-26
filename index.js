require('dotenv').config()
console.log('Starting JobJuicer backend...')
const express = require('express')
const bodyParser = require('body-parser')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const { createClient } = require('@supabase/supabase-js')
const { OpenAI } = require('openai')
const fs = require('fs')
//const PDFDocument = require('pdfkit') DELETED THIS AND PUT MARKDOWN INSTEAD
const markdownPdf = require('markdown-pdf')

// ✅ PDF generator function
function generateResumePDF(resumeMarkdown, outputPath) {
  return new Promise((resolve, reject) => {
    markdownPdf().from.string(resumeMarkdown).to(outputPath, function (err) {
      if (err) return reject(err)
      resolve(outputPath)
    })
  })
}

function generateCoverLetterPDF(coverMarkdown, outputPath) {
  return new Promise((resolve, reject) => {
    markdownPdf().from.string(coverMarkdown).to(outputPath, function (err) {
      if (err) return reject(err)
      resolve(outputPath)
    })
  })
}

// ✅ Now this can go below:
const app = express()
const cors = require('cors')
app.use(cors())

const endpointSecret = '' // optional for now

// ✅ Enable raw body only for Stripe webhooks
app.use('/webhook', bodyParser.raw({ type: 'application/json' }))

// ✅ Enable JSON body for all other routes
app.use(bodyParser.json())

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

app.post('/create-checkout-session', async (req, res) => {
  const { submissionId } = req.body

  if (!submissionId) {
    return res.status(400).json({ error: 'Missing submissionId' })
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: 599, // €5.99 in cents
            product_data: {
              name: 'Resume & Cover Letter Generation',
              description: 'Automatically crafted resume & cover letter by JobJuicer AI'
            }
          },
          quantity: 1
        }
      ],
      metadata: {
        submission_id: submissionId
      },
      success_url: 'http://localhost:5173?payment=success', //here I have used the payment success and calcelled to detect if the user is coming from stripe
      cancel_url: 'http://localhost:5173?payment=cancelled' //later on add the jobjuicer domain and actual site like jobjuicer.com/calceled and so forth
    })

    res.json({ url: session.url })
  } catch (err) {
    console.error('❌ Stripe session error:', err)
    res.status(500).json({ error: 'Something went wrong' })
  }
})

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature']

  let event

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('❌ Webhook signature error:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  if (event.type === 'checkout.session.completed') {
    const metadata = event.data.object.metadata
    const submissionId = metadata.submission_id

    if (!submissionId) {
      console.error('❌ No submission ID in metadata')
      return res.status(400).send('Missing submission ID')
    }

    // 1. Fetch submission from Supabase
    const { data: submission, error } = await supabase
      .from('submissions')
      .select('*')
      .eq('id', submissionId)
      .single()

    if (error || !submission) {
      console.error('❌ Submission not found:', error)
      return res.status(400).send('Submission not found')
    }

    // 2. Format prompt for GPT
    const experienceFormatted = Array.isArray(submission.experience_json)
      ? submission.experience_json.map((e, i) => `• ${e.entry}`).join('\n')
      : ''

    const prompt = `
You're a professional resume and cover letter writer. Based on the information below, write:

1. A personalized resume
2. A tailored cover letter for the job

Respond with the resume and cover letter only. Do not add any extra instructions, notes, or placeholders. Use markdown formatting (like **bold**, *italic*, ### headers) in both documents.
Respond exactly in this format so the resume and cover letter are separated:

=== RESUME ===
[resume here]

=== COVER LETTER ===
[cover letter here]


Job post (cater to the company's values if present): ${submission.job_text}

Candidate Info (if blank, or simple-come up with realistic attributes that suit the job):
- Name: ${submission.full_name}
- Email: ${submission.email}
- Education (cater this to the job, for example, if they have a degree in marketing and the job ad implies or states that they are looking for a business major, then adapt and make it more fitting): ${submission.education}
- Strengths (draw on these streghts, if the user only states one strength, imporovose and adapt according to the field and job text): ${submission.strengths}
- Achievements (if this is not directly a professional acheivement, take what is applicable to the working world and make it a strenght in there. This is what they consider to be a personal win, so you can adapt that also into a work environment)): ${submission.wins}
- Goals for future job (this can be used as a shorrt motivation as to why they are applying to the job): ${submission.goals}
- Work Experience (this will include role, company, timeframe and a takeaway from the job per employment):
${experienceFormatted}

The resume should be clean, professional, and in bullet points.
The cover letter should be compelling, customized to the job, and aligned with company values (if you can infer them from the job post).
`

    // 3. Send to OpenAI
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      })

      const fullText = completion.choices[0].message.content

      // Splitting into resume and cover letter
      const [_, resumePart, coverPart] = fullText.split(/=== RESUME ===|=== COVER LETTER ===/g)


      // 4. Save to Supabase
      const { error: updateError } = await supabase
        .from('submissions')
        .update({
          is_paid: true,
          resume_text: resumePart?.trim(),
          cover_letter_text: coverPart?.trim() || ''
        })
        .eq('id', submissionId)

      if (updateError) {
        console.error('❌ Failed to update submission:', updateError)
        return res.status(500).send('Error updating record')
      }
try {
  const fullName = submission.full_name || 'Candidate'
const resumePath = `resume_${submissionId}_resume.pdf`
const coverPath = `resume_${submissionId}_cover_letter.pdf`

await generateResumePDF(resumePart?.trim(), fullName, resumePath)
await generateCoverLetterPDF(coverPart?.trim(), fullName, coverPath)

const resumeBuffer = fs.readFileSync(resumePath)
const coverBuffer = fs.readFileSync(coverPath)

const { data: resumeUploadData, error: resumeUploadError } = await supabase.storage
  .from('resumes')
  .upload(`resume_${submissionId}.pdf`, resumeBuffer, {
    contentType: 'application/pdf',
    upsert: true
  })

const { data: coverUploadData, error: coverUploadError } = await supabase.storage
  .from('resumes')
  .upload(`cover_letter_${submissionId}.pdf`, coverBuffer, {
    contentType: 'application/pdf',
    upsert: true
  })

if (resumeUploadError || coverUploadError) {
  console.error('❌ Error uploading PDFs to Supabase:', resumeUploadError || coverUploadError)
} else {
  const resumeUrl = supabase.storage.from('resumes').getPublicUrl(resumeUploadData.path).data.publicUrl
  const coverUrl = supabase.storage.from('resumes').getPublicUrl(coverUploadData.path).data.publicUrl

  await supabase
    .from('submissions')
    .update({
      resume_url: resumeUrl,
      cover_letter_url: coverUrl
    })
    .eq('id', submissionId)

  console.log('✅ File URLs saved to Supabase')
}

if (resumeUploadError || coverUploadError) {
  console.error('❌ Error uploading PDFs to Supabase:', resumeUploadError || coverUploadError)
} else {
  console.log('✅ Both PDFs uploaded to Supabase Storage')

  // ✅ Now let's get public download links
  const resumeUrl = supabase.storage
    .from('resumes')
    .getPublicUrl(`resume_${submissionId}.pdf`).data.publicUrl

  const coverUrl = supabase.storage
    .from('resumes')
    .getPublicUrl(`cover_letter_${submissionId}.pdf`).data.publicUrl

  // ✅ And store those URLs in the database for easy access later
  await supabase
    .from('submissions')
    .update({
      resume_url: resumeUrl,
      cover_letter_url: coverUrl
    })
    .eq('id', submissionId)
}


} catch (pdfErr) {
  console.error('❌ PDF generation error:', pdfErr)
}
      console.log('✅ Resume + Cover letter generated and saved')
      res.status(200).send('Success')
    } catch (err) {
      console.error('❌ OpenAI error:', err)
      res.status(500).send('AI generation failed')
    }
  } else {
    res.status(200).send('Ignored')
  }
})

app.listen(process.env.PORT, () => {
  console.log(`Server running on http://localhost:${process.env.PORT}`)
})
