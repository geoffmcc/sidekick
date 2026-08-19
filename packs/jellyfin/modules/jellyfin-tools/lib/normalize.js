"use strict";

function version(system) {
  return system?.Version || system?.version || null;
}

function capabilities({
  system = {},
  sessions = [],
  libraries = [],
  tasks = [],
  plugins = [],
  liveTv = null,
  metrics = null,
} = {}) {
  return {
    system_info: true,
    sessions: Array.isArray(sessions),
    libraries: Array.isArray(libraries),
    scheduled_tasks: Array.isArray(tasks),
    plugins: Array.isArray(plugins),
    live_tv: liveTv !== null,
    metrics: metrics !== null,
    playback_diagnosis: Array.isArray(sessions),
    events: false,
    webhooks: false,
    backups: false,
    api_version: system?.ProductName ? "jellyfin-api" : "unknown",
  };
}

function systemInfo(system) {
  return {
    server_name: system?.ServerName || null,
    version: version(system),
    server_id: system?.Id || system?.ServerId || null,
    product: system?.ProductName || "Jellyfin",
    operating_system: system?.OperatingSystem || null,
    architecture: system?.SystemArchitecture || null,
    local_address: system?.LocalAddress || null,
  };
}

function session(raw) {
  const item = raw?.NowPlayingItem || {};
  const transcoding = raw?.TranscodingInfo || null;
  const video = item.MediaStreams?.find((stream) => stream.Type === "Video");
  const audio = item.MediaStreams?.find((stream) => stream.Type === "Audio");
  const runtimeTicks = Number(item?.RunTimeTicks);
  const runtime = Number.isFinite(runtimeTicks) && runtimeTicks >= 0
    ? {
        ticks: runtimeTicks,
        seconds: Math.round((runtimeTicks / 10000000) * 100) / 100,
        minutes: Math.round((runtimeTicks / 10000000 / 60) * 100) / 100,
      }
    : { ticks: null, seconds: null, minutes: null };
  const positionTicks = Number(raw?.PlayState?.PositionTicks ?? raw?.PositionTicks);
  const playbackPosition = Number.isFinite(positionTicks) && positionTicks >= 0
    ? {
        ticks: positionTicks,
        seconds: Math.round((positionTicks / 10000000) * 100) / 100,
        minutes: Math.round((positionTicks / 10000000 / 60) * 100) / 100,
      }
    : { ticks: null, seconds: null, minutes: null };

  return {
    id: raw?.Id || null,
    user: raw?.UserName || null,
    user_id: raw?.UserId || null,
    device: {
      name: raw?.DeviceName || null,
      client: raw?.Client || null,
      version: raw?.ApplicationVersion || null,
      ip: raw?.RemoteEndPoint || null,
    },
    media: {
      id: item.Id || null,
      name: item.Name || null,
      container: item.Container || null,
      video_codec: video?.Codec || null,
      audio_codec: audio?.Codec || null,
      runtime,
    },
    playback_method: raw?.PlayState?.PlayMethod || raw?.PlayMethod || null,
    is_paused: raw?.PlayState?.IsPaused ?? null,
    can_seek: raw?.PlayState?.CanSeek ?? null,
    playback_position: playbackPosition,
    transcoding: transcoding
      ? {
          video_codec: transcoding.VideoCodec || null,
          audio_codec: transcoding.AudioCodec || null,
          container: transcoding.Container || null,
          reason: transcoding.TranscodeReasons || [],
          hardware_acceleration: transcoding.HardwareAccelerationType || null,
          completion_percent: transcoding.CompletionPercentage ?? null,
          speed: transcoding.Framerate ?? null,
        }
      : null,
  };
}

function diagnose(rawSession) {
  const current = session(rawSession);
  const observed = [];
  const unknowns = [];

  if (current.playback_method)
    observed.push({ fact: "playback_method", value: current.playback_method });
  if (current.playback_position.ticks !== null)
    observed.push({ fact: "playback_position", value: current.playback_position });
  if (current.transcoding)
    observed.push({ fact: "transcoding_info", value: current.transcoding });
  if (current.media.video_codec)
    observed.push({
      fact: "source_video_codec",
      value: current.media.video_codec,
    });
  if (current.media.audio_codec)
    observed.push({
      fact: "source_audio_codec",
      value: current.media.audio_codec,
    });

  if (!current.transcoding && current.playback_method) {
    return {
      classification:
        current.playback_method === "DirectPlay"
          ? "direct_play"
          : "direct_stream",
      observed,
      conclusion: "Jellyfin is not transcoding this session.",
      unknowns,
      recommended_next_check: null,
    };
  }
  if (!current.transcoding) {
    unknowns.push(
      "Jellyfin did not expose transcoding details for this session",
    );
    return {
      classification: "insufficient_evidence",
      observed,
      conclusion:
        "The session cannot be diagnosed deterministically from the available Jellyfin evidence.",
      unknowns,
      recommended_next_check: "Capture the session while playback is active",
    };
  }

  const reasons = current.transcoding.reason || [];
  let classification = "transcoding";
  let conclusion = "Jellyfin is transcoding this session.";
  if (reasons.some((reason) => /subtitle/i.test(reason))) {
    classification = "subtitle_burn_in";
    conclusion = "Subtitle processing is a reported transcoding reason.";
  } else if (reasons.some((reason) => /bitrate/i.test(reason))) {
    classification = "bitrate_limit";
    conclusion = "The requested bitrate is a reported transcoding reason.";
  } else if (reasons.some((reason) => /audio/i.test(reason))) {
    classification = "audio_transcode";
    conclusion = "Audio compatibility is a reported transcoding reason.";
  } else if (
    reasons.some((reason) =>
      /video|codec|profile|level|resolution|hdr|tonemap/i.test(reason),
    )
  ) {
    classification = "video_transcode";
    conclusion =
      "Video compatibility or presentation is a reported transcoding reason.";
  }
  if (
    current.transcoding.hardware_acceleration &&
    /none|software/i.test(current.transcoding.hardware_acceleration)
  ) {
    conclusion += " Jellyfin reports a software path.";
  }
  if (!reasons.length)
    unknowns.push("Jellyfin did not report a transcoding reason");

  return {
    classification,
    observed,
    conclusion,
    unknowns,
    recommended_next_check: unknowns.length
      ? "Inspect the Jellyfin transcode log for this session"
      : null,
  };
}

module.exports = { version, capabilities, systemInfo, session, diagnose };
