import React from 'react';

interface Props { isNight: boolean; customDayImg?: string | null; customNightImg?: string | null }

export const RoseGardenBackground: React.FC<Props> = ({ isNight, customDayImg, customNightImg }) => (
  <>
    <div className={`rose-painting${isNight ? ' rose-painting-night' : ''}`} style={{
      backgroundImage: `url(${JSON.stringify((isNight ? customNightImg : customDayImg) || '/assets/luma-rose-garden-user-v2.jpg')})`,
    }} aria-hidden="true" />
    <div className="rose-top-shade" aria-hidden="true" />
  </>
);
