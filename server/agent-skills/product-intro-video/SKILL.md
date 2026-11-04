---
name: product-intro-video
description: Use when making an intro video, feature demo video or promo short for software or a product: set the structure, pick cards, lay out the timeline, and check by looking at the picture. Read when the user says "introduce this software", "make a feature demo" or "make a promo short".
---

# Product intro video

Always build the video on the timeline with cards and media.

## Set the structure first

1. Read the project first: `get_project` shows the canvas size and frame rate, and `list_media` shows whether the user supplied screenshots, screen recordings and logos.
2. If the user did not specify a length, make it 30 to 60 seconds. A video says only one thing: what problem this product solves, and for whom.
3. Arrange in this order, with one key point per segment:
   - Opening, 3 to 5 seconds: the product name and a one-line positioning statement.
   - Features, 2 to 4 segments of 5 to 10 seconds each: one picture per feature, with just one sentence.
   - Closing, 3 to 5 seconds: the product name and what the user should do next.
4. If the user supplied copy or a script, follow it; the durations and segment counts here apply only when the user did not specify.

## While making it

1. Use `list_cards` and pick a card by its `useWhen`; once chosen, call it again with `cardId` to get the parameters, then `add_clip`.
2. When real UI media is available, use it first and use fewer abstract graphics. When there is none, do not fabricate UI screenshots; express it with text cards and motion graphics.
3. One sentence per screen, large text, and leave enough time to read it. Keep the fonts and colors consistent across the whole video.
4. Create a new card only for visuals that cannot be achieved by adjusting a card's parameters, and respect the creativity level.

## Before delivery

1. Use `see_frames` to look at the key frames of each segment and check whether any text is covered or runs off the picture.
2. Check the durations and segments of the video from start to end, then wrap up with `report_progress`, stating clearly which media were used and which places are placeholder content.
