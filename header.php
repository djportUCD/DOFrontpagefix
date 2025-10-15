<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?php echo isset($HEADER_OPTIONS['title']) ? $HEADER_OPTIONS['title'] : 'MMRRC'; ?></title>
    
    <!-- Bootstrap 3 CSS -->
    <link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/3.4.1/css/bootstrap.min.css">
    
    <!-- jQuery (required for Bootstrap JS) -->
    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
</head>
<body>
    <div class="<?php echo isset($HEADER_OPTIONS['fullwidth']) && $HEADER_OPTIONS['fullwidth'] ? 'container-fluid' : 'container'; ?>">
