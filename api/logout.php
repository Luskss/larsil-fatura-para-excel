<?php
declare(strict_types=1);

session_start();
session_destroy();

header('Content-Type: application/json; charset=utf-8');
echo json_encode(['success' => true]);
