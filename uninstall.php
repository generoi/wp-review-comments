<?php

/**
 * Deleting the plugin stops its daily cleanup. Comments, rounds and
 * screenshots are kept: review feedback is the site's data, and installing
 * the plugin again brings it back.
 */
defined('WP_UNINSTALL_PLUGIN') || exit;

wp_clear_scheduled_hook('wp_review_comments_cleanup');
