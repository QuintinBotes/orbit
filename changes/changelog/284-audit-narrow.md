section: Fixes

- **A criterion whose new tests sit in a long existing test file can be audited (#284).** The criterion audit gave the auditor each mapped test file whole and refused when the packet passed 60,000 characters, so a criterion whose cases were added to an existing large file stayed unproven whatever they said. A mapped test file that existed before the change is now cut to the cases the candidate added or changed, with its imports, helpers and describe lines; unchanged cases become one marker line. A new file is still read whole, and the planner is told the limit.
