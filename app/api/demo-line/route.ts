import { DEMO, env } from "@/lib/config";

/**
 * TwiML for the demo support line (a Twilio number whose Voice URL points here).
 * Plays a phone menu, then ~50 s of recorded messages + hold music, then dials the AI "rep" (a Vapi number).
 */
const say = (t: string) => `<Say voice="${DEMO.voice}">${t}</Say>`;
const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { "Content-Type": "text/xml" } });

export async function POST(req: Request) {
  const q = new URL(req.url).searchParams;
  const self = `${env.publicBaseUrl}/api/demo-line`;
  const music = `<Play>${env.publicBaseUrl}${DEMO.holdMusicPath}</Play>`;

  if (q.get("step") === "hold") return xml(
    say("You have reached billing. Your call is important to us. All of our agents are currently helping other customers. The estimated wait time is less than one minute.") +
    music +
    say("Thank you for holding. This call may be recorded for quality and training purposes. Please continue to hold, and the next available agent will be with you shortly.") +
    music +
    `<Dial timeout="20">${env.demoRepNumber}</Dial>` +
    say("Sorry, all of our agents are busy. Please call again later. Goodbye."));

  // Phone menu; any key or spoken answer goes to billing. One retry, then billing anyway so the demo never stalls.
  const retry = q.get("try") === "1";
  return xml(
    `<Gather input="dtmf speech" numDigits="1" timeout="6" speechTimeout="auto" hints="billing, technical support, representative" action="${self}?step=hold" method="POST">` +
    say(retry ? "Sorry, I didn't get that. For billing, press 1. For technical support, press 2."
      : "Thank you for calling Northstar Internet. This is a demo line. For billing, press 1. For technical support, press 2. For all other questions, press 0.") +
    `</Gather><Redirect method="POST">${self}?step=${retry ? "hold" : "menu&amp;try=1"}</Redirect>`);
}
